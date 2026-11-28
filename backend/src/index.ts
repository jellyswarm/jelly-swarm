import "dotenv/config";
import { app } from "./app";
import { migrate } from "./db/migrate";
import { pool } from "./db";
import { runJobAgents } from "./services/agents";
import { executeRefundPayout, executeSuccessPayout } from "./services/settlements";

const port = Number(process.env.PORT ?? 3001);
await migrate();

async function recoverWorkers() {
  const abandoned = await pool.query<{ id: string }>(
    `UPDATE swarm_jobs SET status = 'failed', error_code = 'worker_lease_exhausted',
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE status = 'running' AND lease_attempts >= 3
       AND (lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING id`,
  );
  if (abandoned.rowCount) console.warn(`Marked ${abandoned.rowCount} exhausted job lease(s) for operator settlement.`);

  const runnable = await pool.query<{ id: string }>(
    `SELECT id FROM swarm_jobs
     WHERE status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()) AND lease_attempts < 3)
     ORDER BY created_at LIMIT 25`,
  );
  for (const job of runnable.rows) {
    void runJobAgents(job.id).catch(() => console.error(`Job worker remains pending for job ${job.id}.`));
  }
}

async function recoverPayouts() {
  const pending = await pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM swarm_jobs WHERE status IN ('payout_pending', 'settlement_pending') ORDER BY created_at LIMIT 25",
  );
  for (const job of pending.rows) {
    const retry = job.status === "payout_pending" ? executeSuccessPayout : executeRefundPayout;
    void retry(job.id).catch(() => console.error(`Payout retry remains pending for job ${job.id}.`));
  }
}

await recoverWorkers();
await recoverPayouts();
const workerRecovery = setInterval(() => void recoverWorkers().catch(() => console.error("Worker recovery scan failed.")), 15_000);
const payoutRecovery = setInterval(() => void recoverPayouts().catch(() => console.error("Payout recovery scan failed.")), 15_000);
workerRecovery.unref?.();
payoutRecovery.unref?.();

const server = app.listen(port, () => console.info(`JellySwarm API listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
