import type { Address, Hash } from "viem";
import { pool } from "../db";
import { getChainClient, getPaymentConfig, sendEscrowTransfer } from "./chain";

type PayoutJob = {
  client_address: string;
  amount_base_units: string;
  status: string;
  settlement_share_bps: number | null;
  client_payout_tx_hash: string | null;
  treasury_payout_tx_hash: string | null;
};

async function trackedTransfer(
  jobId: string,
  column: "client_payout_tx_hash" | "treasury_payout_tx_hash",
  recipient: Address,
  amount: bigint,
  existingHash: string | null,
): Promise<string | null> {
  if (amount === 0n) return null;
  let hash = existingHash;
  if (!hash) {
    const sentHash = await sendEscrowTransfer(recipient, amount);
    hash = sentHash;
    await pool.query(`UPDATE jobs SET ${column} = $2, updated_at = now() WHERE id = $1`, [jobId, hash]);
  }
  const receipt = await getChainClient().waitForTransactionReceipt({ hash: hash as Hash, confirmations: 3, timeout: 90_000 });
  if (receipt.status !== "success") {
    await pool.query(`UPDATE jobs SET ${column} = NULL, updated_at = now() WHERE id = $1 AND ${column} = $2`, [jobId, hash]);
    throw new Error("payout_transaction_reverted");
  }
  return hash;
}

async function lockJob(jobId: string, run: () => Promise<{ status: string; transactions: string[] }>) {
  const lockConnection = await pool.connect();
  try {
    await lockConnection.query("SELECT pg_advisory_lock(hashtext($1))", [jobId]);
    return await run();
  } finally {
    try {
      await lockConnection.query("SELECT pg_advisory_unlock(hashtext($1))", [jobId]);
    } finally {
      lockConnection.release();
    }
  }
}

export async function executeSuccessPayout(jobId: string) {
  return lockJob(jobId, async () => {
    const payment = getPaymentConfig();
    const result = await pool.query<PayoutJob>(
      `SELECT client_address, amount_base_units, status, settlement_share_bps,
              client_payout_tx_hash, treasury_payout_tx_hash
       FROM jobs WHERE id = $1`,
      [jobId],
    );
    const job = result.rows[0];
    if (!job) throw new Error("job_not_found");
    if (job.status === "settled") return { status: "settled", transactions: [] };
    if (job.status !== "payout_pending") throw new Error("success_payout_not_pending");

    const treasuryHash = await trackedTransfer(
      jobId,
      "treasury_payout_tx_hash",
      payment.treasury,
      BigInt(job.amount_base_units),
      job.treasury_payout_tx_hash,
    );
    const finalHash = treasuryHash;
    await pool.query(
      "UPDATE jobs SET status = 'settled', settlement_tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'payout_pending'",
      [jobId, finalHash],
    );
    return { status: "settled", transactions: finalHash ? [finalHash] : [] };
  });
}

export async function executeRefundPayout(jobId: string) {
  return lockJob(jobId, async () => {
    const payment = getPaymentConfig();
    const result = await pool.query<PayoutJob>(
      `SELECT client_address, amount_base_units, status, settlement_share_bps,
              client_payout_tx_hash, treasury_payout_tx_hash
       FROM jobs WHERE id = $1`,
      [jobId],
    );
    const job = result.rows[0];
    if (!job) throw new Error("job_not_found");
    if (job.status === "settled") return { status: "settled", transactions: [] };
    if (job.status !== "settlement_pending" || !job.settlement_share_bps) throw new Error("refund_payout_not_pending");

    const amount = BigInt(job.amount_base_units);
    const clientAmount = (amount * BigInt(job.settlement_share_bps)) / 10_000n;
    const treasuryAmount = amount - clientAmount;
    const clientHash = await trackedTransfer(
      jobId,
      "client_payout_tx_hash",
      job.client_address as Address,
      clientAmount,
      job.client_payout_tx_hash,
    );
    const treasuryHash = await trackedTransfer(
      jobId,
      "treasury_payout_tx_hash",
      payment.treasury,
      treasuryAmount,
      job.treasury_payout_tx_hash,
    );
    const finalHash = treasuryHash ?? clientHash;
    await pool.query(
      "UPDATE jobs SET status = 'settled', settlement_tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'settlement_pending'",
      [jobId, finalHash],
    );
    return { status: "settled", transactions: [clientHash, treasuryHash].filter((hash): hash is string => Boolean(hash)) };
  });
}
