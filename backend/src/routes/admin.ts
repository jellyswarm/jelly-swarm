import { Router, type Response } from "express";
import { recoverTypedDataAddress, type Hash } from "viem";
import { pool } from "../db";
import { consumeRateLimit } from "../services/rate-limit";
import {
  adminPasswordConfigured,
  adminPasswordMatches,
  clearAdminSessionCookie,
  requireAdminSession,
  setAdminSessionCookie,
} from "../services/admin-auth";
import { getChainConfig, getPaymentConfig } from "../services/chain";
import { executeRefundPayout } from "../services/settlements";

export const adminRouter = Router();

const refundShares = new Set([5_000, 7_000, 10_000]);
const settlementTypes = {
  SettlementDecision: [
    { name: "jobId", type: "bytes32" },
    { name: "client", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "clientShareBps", type: "uint16" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const allowedStatuses = new Set(["all", "payment_pending", "queued", "running", "payout_pending", "failed", "settlement_pending", "settled"]);
const jobIdPattern = /^(?:0x)?[\da-fA-F]{64}$/;

function adminError(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

adminRouter.post("/session", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!adminPasswordConfigured()) return adminError(res, 503, "admin_auth_not_configured");

  const identity = req.header("x-jellyswarm-client-ip") ?? req.ip ?? "unknown";
  if (!(await consumeRateLimit("admin_login", identity, 5))) {
    res.setHeader("Retry-After", "60");
    return adminError(res, 429, "admin_login_rate_limited");
  }
  if (!adminPasswordMatches(req.body?.password)) return adminError(res, 401, "invalid_admin_password");

  const expiresAt = setAdminSessionCookie(res);
  return res.json({ authenticated: true, expiresAt });
});

adminRouter.get("/session", requireAdminSession, (_req, res) => {
  res.json({ authenticated: true, expiresAt: res.locals.adminSessionExpiresAt });
});

adminRouter.delete("/session", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  clearAdminSessionCookie(res);
  return res.status(204).end();
});

adminRouter.use(requireAdminSession);

adminRouter.get("/config", (_req, res) => {
  const treasury = process.env.TREASURY_PUBLIC_KEY;
  if (!treasury || !/^0x[\da-fA-F]{40}$/.test(treasury)) return adminError(res, 503, "treasury_signer_not_configured");
  const chain = getChainConfig();
  return res.json({ treasuryPublicKey: treasury, chainId: chain.id });
});

adminRouter.get("/summary", async (_req, res) => {
  const result = await pool.query<{ status: string; count: number; amount: string }>(
    `SELECT status, count(*)::int AS count, coalesce(sum(amount_base_units), 0)::text AS amount
     FROM swarm_jobs GROUP BY status`,
  );
  const statuses = Object.fromEntries(result.rows.map((row) => [row.status, { count: row.count, amountBaseUnits: row.amount }]));
  return res.json({ statuses, generatedAt: new Date().toISOString() });
});

adminRouter.get("/jobs", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "all";
  if (!allowedStatuses.has(status)) return adminError(res, 400, "invalid_job_status_filter");
  const requestedLimit = Number(req.query.limit ?? 50);
  const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const result = await pool.query(
    `SELECT id, client_address AS "clientAddress", task, agent_count AS "agentCount",
            amount_base_units AS "amountBaseUnits", status, payment_tx_hash AS "paymentTransactionHash",
            successful_agent_count AS "successfulAgentCount", error_code AS "errorCode",
            settlement_share_bps AS "settlementShareBps", settlement_tx_hash AS "settlementTransactionHash",
            client_payout_tx_hash AS "clientPayoutTransactionHash", treasury_payout_tx_hash AS "treasuryPayoutTransactionHash",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM swarm_jobs WHERE ($1 = 'all' OR status = $1)
     ORDER BY created_at DESC LIMIT $2`,
    [status, limit],
  );
  return res.json({ jobs: result.rows.map((job) => ({ ...job, id: `0x${String(job.id).trim()}` })) });
});

adminRouter.get("/jobs/:id", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  if (!jobIdPattern.test(req.params.id)) return adminError(res, 400, "invalid_job_id");
  const [jobResult, agents, payouts] = await Promise.all([
    pool.query(
      `SELECT id, client_address AS "clientAddress", task, agent_count AS "agentCount",
              amount_base_units AS "amountBaseUnits", status, payment_tx_hash AS "paymentTransactionHash",
              result, error_code AS "errorCode", successful_agent_count AS "successfulAgentCount",
              automatic_refund_base_units AS "automaticRefundBaseUnits",
              settlement_share_bps AS "settlementShareBps", settlement_tx_hash AS "settlementTransactionHash",
              client_payout_tx_hash AS "clientPayoutTransactionHash", treasury_payout_tx_hash AS "treasuryPayoutTransactionHash",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM swarm_jobs WHERE id = $1`,
      [id.toLowerCase()],
    ),
    pool.query(
      `SELECT agent_number AS "agentNumber", status, output, error_code AS "errorCode", attempt_count AS "attemptCount",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM swarm_job_agents WHERE job_id = $1 ORDER BY agent_number`,
      [id.toLowerCase()],
    ),
    pool.query(
      `SELECT kind, recipient, amount_base_units AS "amountBaseUnits", status, nonce,
              transaction_hash AS "transactionHash", replaced_hashes AS "replacedHashes",
              replacement_count AS "replacementCount", error_code AS "errorCode", updated_at AS "updatedAt"
       FROM swarm_payouts WHERE job_id = $1 ORDER BY kind`,
      [id.toLowerCase()],
    ),
  ]);
  const job = jobResult.rows[0];
  if (!job) return adminError(res, 404, "job_not_found");
  return res.json({ job: { ...job, id: `0x${String(job.id).trim()}` }, agents: agents.rows, payouts: payouts.rows });
});

adminRouter.get("/jobs/:id/settlement/typed-data", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  const clientShareBps = Number(req.query.clientShareBps);
  const deadline = Number(req.query.deadline);
  if (!jobIdPattern.test(req.params.id) || !refundShares.has(clientShareBps) || !Number.isSafeInteger(deadline)) {
    return adminError(res, 400, "invalid_settlement_decision");
  }
  if (deadline <= Math.floor(Date.now() / 1000)) return adminError(res, 400, "settlement_decision_expired");
  const payment = getPaymentConfig();
  const job = await pool.query<{ status: string; client_address: string; amount_base_units: string }>(
    "SELECT status, client_address, amount_base_units FROM swarm_jobs WHERE id = $1",
    [id.toLowerCase()],
  );
  if (!job.rows[0]) return adminError(res, 404, "job_not_found");
  if (job.rows[0].status !== "failed" && job.rows[0].status !== "settlement_pending") {
    return adminError(res, 409, "job_not_ready_for_settlement");
  }
  const chain = getChainConfig();
  return res.json({
    domain: { name: "JellySwarmEscrowWallet", version: "1", chainId: chain.id, verifyingContract: payment.escrow },
    types: settlementTypes,
    primaryType: "SettlementDecision",
    message: {
      jobId: `0x${id}`,
      client: job.rows[0].client_address,
      amount: job.rows[0].amount_base_units,
      clientShareBps,
      nonce: "0",
      deadline: String(deadline),
    },
  });
});

adminRouter.post("/jobs/:id/settlement", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  const clientShareBps = req.body?.clientShareBps;
  const deadline = req.body?.deadline;
  const rawSignature = req.body?.signature;
  if (!jobIdPattern.test(req.params.id) || !refundShares.has(clientShareBps) || !Number.isSafeInteger(deadline) ||
      typeof rawSignature !== "string" || !/^0x[\da-fA-F]{130}$/.test(rawSignature)) {
    return adminError(res, 400, "invalid_settlement_decision");
  }
  const treasury = process.env.TREASURY_PUBLIC_KEY;
  const payment = getPaymentConfig();
  if (!treasury || !/^0x[\da-fA-F]{40}$/.test(treasury)) return adminError(res, 503, "treasury_signer_not_configured");
  const result = await pool.query<{ status: string; client_address: string; amount_base_units: string }>(
    "SELECT status, client_address, amount_base_units FROM swarm_jobs WHERE id = $1",
    [id.toLowerCase()],
  );
  const job = result.rows[0];
  if (!job) return adminError(res, 404, "job_not_found");
  if (job.status !== "failed" && job.status !== "settlement_pending") return adminError(res, 409, "job_not_ready_for_refund_decision");
  if (job.status === "failed" && deadline <= Math.floor(Date.now() / 1000)) return adminError(res, 400, "settlement_decision_expired");

  const chain = getChainConfig();
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: { name: "JellySwarmEscrowWallet", version: "1", chainId: chain.id, verifyingContract: payment.escrow },
      types: settlementTypes,
      primaryType: "SettlementDecision",
      message: {
        jobId: `0x${id}` as Hash,
        client: job.client_address as `0x${string}`,
        amount: BigInt(job.amount_base_units),
        clientShareBps,
        nonce: 0n,
        deadline: BigInt(deadline),
      },
      signature: rawSignature as Hash,
    });
  } catch {
    return adminError(res, 400, "invalid_settlement_signature");
  }
  if (recovered.toLowerCase() !== treasury.toLowerCase()) return adminError(res, 403, "unauthorized_treasury_signature");

  const stored = await pool.query(
    `UPDATE swarm_jobs SET status = 'settlement_pending', settlement_share_bps = $2,
            settlement_deadline = $3, settlement_signature = $4, updated_at = now()
     WHERE id = $1 AND status = 'failed' RETURNING id`,
    [id.toLowerCase(), clientShareBps, deadline, rawSignature],
  );
  if (!stored.rows[0]) {
    const existing = await pool.query<{ settlement_signature: string | null; settlement_share_bps: number | null }>(
      "SELECT settlement_signature, settlement_share_bps FROM swarm_jobs WHERE id = $1 AND status = 'settlement_pending'",
      [id.toLowerCase()],
    );
    if (existing.rows[0]?.settlement_signature !== rawSignature || existing.rows[0]?.settlement_share_bps !== clientShareBps) {
      return adminError(res, 409, "settlement_already_recorded");
    }
  }
  try {
    const payout = await executeRefundPayout(id.toLowerCase());
    return res.json({ jobId: `0x${id}`, status: payout.status, payouts: payout.transactions });
  } catch {
    return res.status(503).json({ error: "payout_pending_retry_required", status: "settlement_pending" });
  }
});
