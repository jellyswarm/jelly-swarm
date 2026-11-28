import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pool } from "../src/db";
import { migrate } from "../src/db/migrate";
import { claimJob } from "../src/services/agents";
import { consumeRateLimit } from "../src/services/rate-limit";

const enabled = process.env.RUN_DB_TESTS === "1";
const dbDescribe = enabled ? describe : describe.skip;
const jobIds: string[] = [];

dbDescribe("PostgreSQL safety integration", () => {
  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    if (jobIds.length) await pool.query("DELETE FROM swarm_jobs WHERE id = ANY($1::char(64)[])", [jobIds]);
    await pool.end();
  });

  test("a queued job can be leased by only one worker", async () => {
    const id = randomBytes(32).toString("hex");
    jobIds.push(id);
    await pool.query(
      `INSERT INTO swarm_jobs (id, client_address, task, agent_count, amount_base_units, status)
       VALUES ($1, $2, $3, 1, 300000, 'queued')`,
      [id, "0xB64e1dB47748784E9D3fE125aa09D4Edb6163653", "integration lease test"],
    );

    const [first, second] = await Promise.all([claimJob(id, "worker-a"), claimJob(id, "worker-b")]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const stored = await pool.query<{ lease_owner: string; lease_attempts: number }>(
      "SELECT lease_owner, lease_attempts FROM swarm_jobs WHERE id = $1",
      [id],
    );
    expect(["worker-a", "worker-b"]).toContain(stored.rows[0]?.lease_owner);
    expect(stored.rows[0]?.lease_attempts).toBe(1);
  });

  test("rate limits count requests atomically for one visitor bucket", async () => {
    const visitor = randomUUID();
    expect(await consumeRateLimit("db-integration", visitor, 1)).toBe(true);
    expect(await consumeRateLimit("db-integration", visitor, 1)).toBe(false);
  });
});
