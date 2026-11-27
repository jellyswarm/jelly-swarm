import { randomBytes } from "node:crypto";
import { Router, type Response } from "express";
import { recoverTypedDataAddress, type Hash } from "viem";
import { pool } from "../db";
import { assertPaymentReadiness, getChainConfig, getPaymentConfig, verifyFundingReceipt, verifySettlementReceipt } from "../services/chain";
import { runJobAgents } from "../services/agents";

export const jobsRouter = Router();

const shares = new Set([0, 5_000, 7_000, 10_000]);
const settlementTypes = {
  SettlementDecision: [
    { name: "jobId", type: "bytes32" },
    { name: "clientShareBps", type: "uint16" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

function paymentConfiguration(res: Response) {
  try {
    return getPaymentConfig();
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "payment_config_missing" });
    return undefined;
  }
}

jobsRouter.post("/", async (req, res) => {
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  const agentCount = req.body?.agentCount;
  const clientAddress = req.body?.clientAddress;
  const paymentMode = req.body?.paymentMode ?? "x402";
  if (task.length < 3 || task.length > 12_000) return res.status(400).json({ error: "invalid_task" });
  if (!Number.isInteger(agentCount) || agentCount < 1 || agentCount > 247) {
    return res.status(400).json({ error: "agent_count_out_of_range", maximum: 247 });
  }
  if (typeof clientAddress !== "string" || !/^0x[\da-fA-F]{40}$/.test(clientAddress)) {
    return res.status(400).json({ error: "invalid_client_address" });
  }
  if (paymentMode !== "x402" && paymentMode !== "direct") return res.status(400).json({ error: "invalid_payment_mode" });

  const payment = paymentConfiguration(res);
  if (!payment) return;
  let readiness;
  try {
    readiness = await assertPaymentReadiness();
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : "payment_not_ready" });
  }
  const amount = payment.pricePerCallBaseUnits * BigInt(agentCount + 1);
  if (amount > (1n << 128n) - 1n) return res.status(400).json({ error: "quote_too_large" });
  const jobId = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO jobs (id, client_address, task, agent_count, amount_base_units, status)
     VALUES ($1, $2, $3, $4, $5, 'payment_pending')`,
    [jobId, clientAddress.toLowerCase(), task, agentCount, amount.toString()],
  );

  const chain = readiness.chain;
  const requirements = {
    x402Version: 1,
    accepts: [{
      scheme: "exact-escrow",
      network: `eip155:${chain.id}`,
      asset: payment.usdc,
      amount: amount.toString(),
      payTo: payment.escrow,
      resource: `/jobs/${jobId}`,
      description: `JellySwarm job with ${agentCount} agents and one synthesis call`,
      extra: { jobId: `0x${jobId}`, clientAddress: clientAddress.toLowerCase(), agentCount, modelCalls: agentCount + 1, maxAgents: 247 },
    }],
  };
  const response = {
    jobId: `0x${jobId}`,
    agentCount,
    paymentMode,
    payment: requirements,
    approval: { contract: payment.usdc, functionName: "approve", args: [payment.escrow, amount.toString()] },
    fundCall: { contract: payment.escrow, functionName: "fundJob", args: [`0x${jobId}`, amount.toString()] },
    gasToken: "HYPE",
  };
  if (paymentMode === "x402") {
    res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(requirements)).toString("base64"));
    return res.status(402).json({ error: "payment_required", ...response });
  }
  return res.status(201).json(response);
});

jobsRouter.post("/:id/payment", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  if (!/^[\da-f]{64}$/i.test(id)) return res.status(400).json({ error: "invalid_job_id" });
  const txHash = req.body?.transactionHash;
  if (typeof txHash !== "string" || !/^0x[\da-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: "invalid_transaction_hash" });
  }
  const found = await pool.query<{
    client_address: string;
    amount_base_units: string;
    status: string;
  }>("SELECT client_address, amount_base_units, status FROM jobs WHERE id = $1", [id.toLowerCase()]);
  const job = found.rows[0];
  if (!job) return res.status(404).json({ error: "job_not_found" });
  if (job.status !== "payment_pending") return res.status(409).json({ error: "job_not_awaiting_payment", status: job.status });

  try {
    const valid = await verifyFundingReceipt({
      transactionHash: txHash as Hash,
      jobId: `0x${id}`,
      clientAddress: job.client_address as `0x${string}`,
      amountBaseUnits: BigInt(job.amount_base_units),
    });
    if (!valid) return res.status(409).json({ error: "payment_not_confirmed" });
  } catch {
    return res.status(502).json({ error: "payment_verification_unavailable" });
  }

  const updated = await pool.query(
    `UPDATE jobs SET status = 'queued', payment_tx_hash = $2, updated_at = now()
     WHERE id = $1 AND status = 'payment_pending' RETURNING task, agent_count`,
    [id.toLowerCase(), txHash.toLowerCase()],
  );
  if (!updated.rows[0]) return res.status(409).json({ error: "job_payment_already_recorded" });
  const paidJob = updated.rows[0] as { task: string; agent_count: number };
  void runJobAgents(id.toLowerCase(), paidJob.task, paidJob.agent_count).catch(async () => {
    await pool.query("UPDATE jobs SET status = 'failed', error_code = 'agent_worker_failed', updated_at = now() WHERE id = $1", [id.toLowerCase()]);
  });
  return res.status(202).json({ jobId: `0x${id}`, status: "queued" });
});

jobsRouter.get("/:id", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  if (!/^[\da-f]{64}$/i.test(id)) return res.status(400).json({ error: "invalid_job_id" });
  const result = await pool.query(
    `SELECT id, client_address AS "clientAddress", agent_count AS "agentCount",
            amount_base_units AS "amountBaseUnits", status, payment_tx_hash AS "paymentTransactionHash",
            result, error_code AS "errorCode", settlement_share_bps AS "settlementShareBps",
            settlement_deadline AS "settlementDeadline", settlement_tx_hash AS "settlementTransactionHash",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM jobs WHERE id = $1`,
    [id.toLowerCase()],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "job_not_found" });
  return res.json({ ...result.rows[0], id: `0x${id}` });
});

jobsRouter.get("/:id/agents", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  if (!/^[\da-f]{64}$/i.test(id)) return res.status(400).json({ error: "invalid_job_id" });
  const result = await pool.query(
    `SELECT agent_number AS "agentNumber", status, output, error_code AS "errorCode",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM job_agents WHERE job_id = $1 ORDER BY agent_number`,
    [id.toLowerCase()],
  );
  return res.json({ agents: result.rows });
});

jobsRouter.get("/:id/settlement/typed-data", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  const clientShareBps = Number(req.query.clientShareBps);
  const deadline = Number(req.query.deadline);
  if (!/^[\da-f]{64}$/i.test(id) || !shares.has(clientShareBps) || !Number.isSafeInteger(deadline)) {
    return res.status(400).json({ error: "invalid_settlement_decision" });
  }
  if (deadline <= Math.floor(Date.now() / 1000)) return res.status(400).json({ error: "settlement_decision_expired" });
  const payment = paymentConfiguration(res);
  if (!payment) return;
  const result = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [id.toLowerCase()]);
  if (!result.rows[0]) return res.status(404).json({ error: "job_not_found" });
  if (result.rows[0].status !== "completed" && result.rows[0].status !== "failed") {
    return res.status(409).json({ error: "job_not_ready_for_settlement" });
  }
  const chain = getChainConfig();
  return res.json({
    domain: { name: "JellySwarmEscrow", version: "1", chainId: chain.id, verifyingContract: payment.escrow },
    types: settlementTypes,
    primaryType: "SettlementDecision",
    message: { jobId: `0x${id}`, clientShareBps, nonce: "0", deadline: String(deadline) },
  });
});

jobsRouter.post("/:id/settlement", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  if (!/^[\da-f]{64}$/i.test(id)) return res.status(400).json({ error: "invalid_job_id" });
  const clientShareBps = req.body?.clientShareBps;
  const deadline = req.body?.deadline;
  const signature = req.body?.signature;
  if (!shares.has(clientShareBps) || !Number.isSafeInteger(deadline) || typeof signature !== "string" || !/^0x[\da-fA-F]{130}$/.test(signature)) {
    return res.status(400).json({ error: "invalid_settlement_decision" });
  }

  const payment = paymentConfiguration(res);
  if (!payment) return;
  const treasury = process.env.TREASURY_PUBLIC_KEY;
  if (!treasury || !/^0x[\da-fA-F]{40}$/.test(treasury)) return res.status(503).json({ error: "treasury_signer_not_configured" });
  if (deadline <= Math.floor(Date.now() / 1000)) return res.status(400).json({ error: "settlement_decision_expired" });

  const result = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [id.toLowerCase()]);
  const job = result.rows[0];
  if (!job) return res.status(404).json({ error: "job_not_found" });
  if (job.status !== "completed" && job.status !== "failed") return res.status(409).json({ error: "job_not_ready_for_settlement" });

  const chain = getChainConfig();
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: { name: "JellySwarmEscrow", version: "1", chainId: chain.id, verifyingContract: payment.escrow },
      types: settlementTypes,
      primaryType: "SettlementDecision",
      message: { jobId: `0x${id}`, clientShareBps, nonce: 0n, deadline: BigInt(deadline) },
      signature: signature as Hash,
    });
  } catch {
    return res.status(400).json({ error: "invalid_settlement_signature" });
  }
  if (recovered.toLowerCase() !== treasury.toLowerCase()) return res.status(403).json({ error: "unauthorized_treasury_signature" });

  const updated = await pool.query(
    `UPDATE jobs SET status = 'settlement_ready', settlement_share_bps = $2,
            settlement_deadline = $3, settlement_signature = $4, updated_at = now()
     WHERE id = $1 AND status IN ('completed', 'failed') RETURNING id`,
    [id.toLowerCase(), clientShareBps, deadline, signature],
  );
  if (!updated.rows[0]) return res.status(409).json({ error: "settlement_already_recorded" });
  return res.json({
    status: "settlement_ready",
    decision: { jobId: `0x${id}`, clientShareBps, nonce: "0", deadline, signature },
    transaction: { to: payment.escrow, functionName: "settleJob", args: [`0x${id}`, clientShareBps, deadline, signature] },
    gasToken: "HYPE",
  });
});

jobsRouter.post("/:id/settlement/confirm", async (req, res) => {
  const id = req.params.id.replace(/^0x/, "");
  const txHash = req.body?.transactionHash;
  if (!/^[\da-f]{64}$/i.test(id) || typeof txHash !== "string" || !/^0x[\da-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: "invalid_settlement_confirmation" });
  }
  const found = await pool.query<{ settlement_share_bps: number; status: string }>(
    "SELECT settlement_share_bps, status FROM jobs WHERE id = $1", [id.toLowerCase()],
  );
  const job = found.rows[0];
  if (!job) return res.status(404).json({ error: "job_not_found" });
  if (job.status !== "settlement_ready" || job.settlement_share_bps === null) return res.status(409).json({ error: "settlement_not_ready" });
  try {
    const valid = await verifySettlementReceipt({ transactionHash: txHash as Hash, jobId: `0x${id}`, clientShareBps: job.settlement_share_bps });
    if (!valid) return res.status(409).json({ error: "settlement_not_confirmed" });
  } catch {
    return res.status(502).json({ error: "settlement_verification_unavailable" });
  }
  await pool.query(
    "UPDATE jobs SET status = 'settled', settlement_tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'settlement_ready'",
    [id.toLowerCase(), txHash.toLowerCase()],
  );
  return res.json({ jobId: `0x${id}`, status: "settled", transactionHash: txHash.toLowerCase() });
});
