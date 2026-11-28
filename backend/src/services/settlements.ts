import type { Address, Hash } from "viem";
import { pool } from "../db";
import { broadcastEscrowTransfer, getChainClient, getPaymentConfig, prepareEscrowTransfer } from "./chain";

type PayoutJob = {
  client_address: string;
  amount_base_units: string;
  automatic_refund_base_units: string;
  status: string;
  settlement_share_bps: number | null;
  client_payout_tx_hash: string | null;
  treasury_payout_tx_hash: string | null;
};
type PayoutIntent = {
  recipient: string;
  amount_base_units: string;
  status: string;
  nonce: string | null;
  raw_transaction: string | null;
  transaction_hash: string | null;
  gas_price: string | null;
  replaced_hashes: string[];
  replacement_count: number;
  broadcast_at: Date | null;
};

const nonceLock = "jellyswarm:escrow-payout-nonce";
const scheduledPayouts = new Map<string, Promise<void>>();

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-zA-Z0-9_:-]{1,80}$/.test(message) ? message : "unexpected_error";
}

async function lockJob(jobId: string, run: () => Promise<{ status: string; transactions: string[] }>) {
  const connection = await pool.connect();
  try {
    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [jobId]);
    return await run();
  } finally {
    try {
      await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [jobId]);
    } finally {
      connection.release();
    }
  }
}

async function persistSignedIntent(jobId: string, kind: "client" | "treasury", recipient: Address, amount: bigint): Promise<PayoutIntent> {
  const column = kind === "client" ? "client_payout_tx_hash" : "treasury_payout_tx_hash";
  await pool.query(
    `INSERT INTO swarm_payouts (job_id, kind, recipient, amount_base_units, status)
     VALUES ($1, $2, $3, $4, 'prepared') ON CONFLICT (job_id, kind) DO NOTHING`,
    [jobId, kind, recipient, amount.toString()],
  );

  const lockConnection = await pool.connect();
  try {
    await lockConnection.query("SELECT pg_advisory_lock(hashtext($1))", [nonceLock]);
    await lockConnection.query("BEGIN");
    const found = await lockConnection.query<PayoutIntent>(
      `SELECT recipient, amount_base_units, status, nonce, raw_transaction, transaction_hash
              , gas_price, replaced_hashes, replacement_count, broadcast_at
       FROM swarm_payouts WHERE job_id = $1 AND kind = $2 FOR UPDATE`,
      [jobId, kind],
    );
    const intent = found.rows[0];
    if (!intent) throw new Error("payout_intent_missing");
    if (intent.recipient.toLowerCase() !== recipient.toLowerCase() || BigInt(intent.amount_base_units) !== amount) {
      throw new Error("payout_intent_mismatch");
    }

    if (!intent.transaction_hash && !intent.raw_transaction) {
      const { escrow } = getPaymentConfig();
      const [pendingNonce, highestStored] = await Promise.all([
        getChainClient().getTransactionCount({ address: escrow, blockTag: "pending" }),
        lockConnection.query<{ nonce: string | null }>("SELECT max(nonce)::text AS nonce FROM swarm_payouts WHERE nonce IS NOT NULL"),
      ]);
      const storedNonce = highestStored.rows[0]?.nonce;
      const nonce = Math.max(pendingNonce, storedNonce === null || storedNonce === undefined ? 0 : Number(storedNonce) + 1);
      const prepared = await prepareEscrowTransfer(recipient, amount, nonce);
      const saved = await lockConnection.query(
        `UPDATE swarm_payouts SET nonce = $3, raw_transaction = $4, transaction_hash = $5, gas_price = $6,
                attempt_count = attempt_count + 1, updated_at = now()
         WHERE job_id = $1 AND kind = $2 AND transaction_hash IS NULL
         RETURNING transaction_hash`,
        [jobId, kind, nonce, prepared.serializedTransaction, prepared.hash, prepared.gasPrice.toString()],
      );
      if (!saved.rowCount) throw new Error("payout_intent_race");
      await lockConnection.query(`UPDATE swarm_jobs SET ${column} = $2, updated_at = now() WHERE id = $1`, [jobId, prepared.hash]);
    }
    await lockConnection.query("COMMIT");
    const latest = await lockConnection.query<PayoutIntent>(
      `SELECT recipient, amount_base_units, status, nonce, raw_transaction, transaction_hash,
              gas_price, replaced_hashes, replacement_count, broadcast_at
       FROM swarm_payouts WHERE job_id = $1 AND kind = $2`,
      [jobId, kind],
    );
    return latest.rows[0];
  } catch (error) {
    await lockConnection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    try {
      await lockConnection.query("SELECT pg_advisory_unlock(hashtext($1))", [nonceLock]);
    } finally {
      lockConnection.release();
    }
  }
}

async function replaceStuckIntent(jobId: string, kind: "client" | "treasury"): Promise<PayoutIntent | null> {
  const column = kind === "client" ? "client_payout_tx_hash" : "treasury_payout_tx_hash";
  const connection = await pool.connect();
  try {
    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [nonceLock]);
    await connection.query("BEGIN");
    const result = await connection.query<PayoutIntent>(
      `SELECT recipient, amount_base_units, status, nonce, raw_transaction, transaction_hash,
              gas_price, replaced_hashes, replacement_count, broadcast_at
       FROM swarm_payouts WHERE job_id = $1 AND kind = $2 FOR UPDATE`,
      [jobId, kind],
    );
    const current = result.rows[0];
    if (!current || !current.nonce || !current.gas_price || !current.broadcast_at || current.replacement_count >= 2 ||
        Date.now() - current.broadcast_at.getTime() < 120_000) {
      await connection.query("ROLLBACK");
      return null;
    }
    const networkGasPrice = await getChainClient().getGasPrice();
    const previousGasPrice = BigInt(current.gas_price);
    const bumpedGasPrice = previousGasPrice * 125n / 100n + 1n;
    const prepared = await prepareEscrowTransfer(
      current.recipient as Address,
      BigInt(current.amount_base_units),
      Number(current.nonce),
      networkGasPrice > bumpedGasPrice ? networkGasPrice : bumpedGasPrice,
    );
    await connection.query(
      `UPDATE swarm_payouts SET replaced_hashes = array_append(replaced_hashes, transaction_hash),
              raw_transaction = $3, transaction_hash = $4, gas_price = $5,
              replacement_count = replacement_count + 1, status = 'prepared', broadcast_at = NULL,
              attempt_count = attempt_count + 1, updated_at = now()
       WHERE job_id = $1 AND kind = $2`,
      [jobId, kind, prepared.serializedTransaction, prepared.hash, prepared.gasPrice.toString()],
    );
    await connection.query(`UPDATE swarm_jobs SET ${column} = $2, updated_at = now() WHERE id = $1`, [jobId, prepared.hash]);
    await connection.query("COMMIT");
    const latest = await connection.query<PayoutIntent>(
      `SELECT recipient, amount_base_units, status, nonce, raw_transaction, transaction_hash,
              gas_price, replaced_hashes, replacement_count, broadcast_at
       FROM swarm_payouts WHERE job_id = $1 AND kind = $2`,
      [jobId, kind],
    );
    return latest.rows[0] ?? null;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    try {
      await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [nonceLock]);
    } finally {
      connection.release();
    }
  }
}

async function trackedTransferInternal(
  jobId: string,
  kind: "client" | "treasury",
  recipient: Address,
  amount: bigint,
  existingHash: string | null,
): Promise<string | null> {
  if (amount === 0n) return null;
  if (existingHash) {
    await pool.query(
      `INSERT INTO swarm_payouts (job_id, kind, recipient, amount_base_units, status, transaction_hash)
       VALUES ($1, $2, $3, $4, 'broadcast', $5) ON CONFLICT (job_id, kind) DO NOTHING`,
      [jobId, kind, recipient, amount.toString(), existingHash],
    );
  }
  const intent = await persistSignedIntent(jobId, kind, recipient, amount);
  if (intent.status === "confirmed") return intent.transaction_hash;
  if (intent.status === "failed") throw new Error("payout_transaction_failed_operator_action_required");
  if (!intent.transaction_hash) throw new Error("payout_transaction_hash_missing");

  const priorHashes = [...(intent.replaced_hashes ?? []), intent.transaction_hash];
  for (const hash of priorHashes) {
    try {
      const knownReceipt = await getChainClient().getTransactionReceipt({ hash: hash as Hash });
      if (knownReceipt.status === "success") {
        await pool.query("UPDATE swarm_payouts SET status = 'confirmed', updated_at = now() WHERE job_id = $1 AND kind = $2", [jobId, kind]);
        const column = kind === "client" ? "client_payout_tx_hash" : "treasury_payout_tx_hash";
        await pool.query(`UPDATE swarm_jobs SET ${column} = $2, updated_at = now() WHERE id = $1`, [jobId, hash]);
        return hash;
      }
      await pool.query(
        "UPDATE swarm_payouts SET status = 'failed', error_code = 'payout_transaction_reverted', updated_at = now() WHERE job_id = $1 AND kind = $2",
        [jobId, kind],
      );
      throw new Error("payout_transaction_reverted");
    } catch (error) {
      if (error instanceof Error && error.message === "payout_transaction_reverted") throw error;
    }
  }

  const replacement = await replaceStuckIntent(jobId, kind);
  const activeIntent = replacement ?? intent;

  if (activeIntent.raw_transaction) {
    try {
      const broadcastHash = await broadcastEscrowTransfer(activeIntent.raw_transaction as `0x${string}`);
      if (broadcastHash.toLowerCase() !== activeIntent.transaction_hash?.toLowerCase()) throw new Error("payout_transaction_hash_mismatch");
      await pool.query(
        "UPDATE swarm_payouts SET status = 'broadcast', broadcast_at = COALESCE(broadcast_at, now()), updated_at = now() WHERE job_id = $1 AND kind = $2 AND status <> 'confirmed'",
        [jobId, kind],
      );
    } catch (error) {
      if (error instanceof Error && error.message === "payout_transaction_hash_mismatch") throw error;
      // A repeated raw transaction is safe: it has the same nonce and hash as the saved intent.
    }
  }

  let receipt;
  try {
    receipt = await getChainClient().waitForTransactionReceipt({ hash: activeIntent.transaction_hash as Hash, confirmations: 3, timeout: 90_000 });
  } catch {
    throw new Error("payout_confirmation_pending");
  }
  if (receipt.status !== "success") {
    await pool.query(
      "UPDATE swarm_payouts SET status = 'failed', error_code = 'payout_transaction_reverted', updated_at = now() WHERE job_id = $1 AND kind = $2",
      [jobId, kind],
    );
    throw new Error("payout_transaction_reverted");
  }
  await pool.query(
    "UPDATE swarm_payouts SET status = 'confirmed', error_code = NULL, updated_at = now() WHERE job_id = $1 AND kind = $2",
    [jobId, kind],
  );
  const column = kind === "client" ? "client_payout_tx_hash" : "treasury_payout_tx_hash";
  await pool.query(`UPDATE swarm_jobs SET ${column} = $2, updated_at = now() WHERE id = $1`, [jobId, activeIntent.transaction_hash]);
  return activeIntent.transaction_hash;
}

async function trackedTransfer(
  jobId: string,
  kind: "client" | "treasury",
  recipient: Address,
  amount: bigint,
  existingHash: string | null,
): Promise<string | null> {
  try {
    return await trackedTransferInternal(jobId, kind, recipient, amount, existingHash);
  } catch (error) {
    console.error(JSON.stringify({
      event: "payout_transfer_failed",
      jobId,
      kind,
      errorCode: safeErrorCode(error),
      errorType: error instanceof Error ? error.name : "unknown_error",
    }));
    throw error;
  }
}

async function loadPayoutJob(jobId: string) {
  const result = await pool.query<PayoutJob>(
    `SELECT client_address, amount_base_units, automatic_refund_base_units, status, settlement_share_bps,
            client_payout_tx_hash, treasury_payout_tx_hash
     FROM swarm_jobs WHERE id = $1`,
    [jobId],
  );
  return result.rows[0];
}

export async function executeSuccessPayout(jobId: string) {
  return lockJob(jobId, async () => {
    const payment = getPaymentConfig();
    const job = await loadPayoutJob(jobId);
    if (!job) throw new Error("job_not_found");
    if (job.status === "settled") return { status: "settled", transactions: [] as string[] };
    if (job.status !== "payout_pending") throw new Error("success_payout_not_pending");

    const amount = BigInt(job.amount_base_units);
    const clientAmount = BigInt(job.automatic_refund_base_units);
    if (clientAmount > amount) throw new Error("automatic_refund_exceeds_job_amount");
    const clientHash = await trackedTransfer(jobId, "client", job.client_address as Address, clientAmount, job.client_payout_tx_hash);
    const treasuryHash = await trackedTransfer(
      jobId,
      "treasury",
      payment.treasury,
      amount - clientAmount,
      job.treasury_payout_tx_hash,
    );
    await pool.query(
      "UPDATE swarm_jobs SET status = 'settled', settlement_tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'payout_pending'",
      [jobId, treasuryHash ?? clientHash],
    );
    return { status: "settled", transactions: [clientHash, treasuryHash].filter((hash): hash is string => Boolean(hash)) };
  });
}

export async function executeRefundPayout(jobId: string) {
  return lockJob(jobId, async () => {
    const payment = getPaymentConfig();
    const job = await loadPayoutJob(jobId);
    if (!job) throw new Error("job_not_found");
    if (job.status === "settled") return { status: "settled", transactions: [] as string[] };
    if (job.status !== "settlement_pending" || !job.settlement_share_bps) throw new Error("refund_payout_not_pending");

    const amount = BigInt(job.amount_base_units);
    const clientAmount = (amount * BigInt(job.settlement_share_bps)) / 10_000n;
    const treasuryAmount = amount - clientAmount;
    const clientHash = await trackedTransfer(jobId, "client", job.client_address as Address, clientAmount, job.client_payout_tx_hash);
    const treasuryHash = await trackedTransfer(jobId, "treasury", payment.treasury, treasuryAmount, job.treasury_payout_tx_hash);
    await pool.query(
      "UPDATE swarm_jobs SET status = 'settled', settlement_tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'settlement_pending'",
      [jobId, treasuryHash ?? clientHash],
    );
    return { status: "settled", transactions: [clientHash, treasuryHash].filter((hash): hash is string => Boolean(hash)) };
  });
}

/** Start a payout retry without holding an HTTP request open while confirmations arrive. */
export function schedulePayoutRecovery(jobId: string, status: "payout_pending" | "settlement_pending"): void {
  if (scheduledPayouts.has(jobId)) return;
  const execute = status === "payout_pending" ? executeSuccessPayout : executeRefundPayout;
  const attempt = execute(jobId)
    .then((result) => {
      console.info(JSON.stringify({ event: "payout_recovery_finished", jobId, status: result.status }));
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ event: "payout_recovery_pending", jobId, errorCode: safeErrorCode(error) }));
    })
    .finally(() => scheduledPayouts.delete(jobId));
  scheduledPayouts.set(jobId, attempt);
}
