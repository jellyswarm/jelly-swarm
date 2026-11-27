import "dotenv/config";
import { app } from "./app";
import { migrate } from "./db/migrate";
import { pool } from "./db";
import { runJobAgents } from "./services/agents";

const port = Number(process.env.PORT ?? 3001);
await migrate();

const interrupted = await pool.query(
  "UPDATE jobs SET status = 'failed', error_code = 'worker_interrupted', updated_at = now() WHERE status = 'running'",
);
if (interrupted.rowCount) console.warn(`Marked ${interrupted.rowCount} interrupted job(s) for operator settlement.`);

const queuedJobs = await pool.query<{ id: string; task: string; agent_count: number }>(
  "SELECT id, task, agent_count FROM jobs WHERE status = 'queued' ORDER BY created_at",
);
for (const job of queuedJobs.rows) {
  void runJobAgents(job.id, job.task, job.agent_count).catch(async () => {
    await pool.query("UPDATE jobs SET status = 'failed', error_code = 'agent_worker_failed', updated_at = now() WHERE id = $1", [job.id]);
  });
}

const server = app.listen(port, () => console.info(`JellySwarm API listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
