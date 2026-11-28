import { createHash } from "node:crypto";
import { pool } from "../db";

let lastCleanupBucket = 0;

export async function consumeRateLimit(scope: string, identity: string, limit: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 60_000);
  const keyHash = createHash("sha256").update(`${scope}:${identity}`).digest("hex");
  const result = await pool.query<{ request_count: number }>(
    `INSERT INTO swarm_api_rate_limits (key_hash, bucket_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (key_hash, bucket_start)
     DO UPDATE SET request_count = swarm_api_rate_limits.request_count + 1
     RETURNING request_count`,
    [keyHash, bucket],
  );

  if (bucket >= lastCleanupBucket + 5) {
    lastCleanupBucket = bucket;
    void pool.query("DELETE FROM swarm_api_rate_limits WHERE bucket_start < $1", [bucket - 10]).catch(() => {});
  }

  return (result.rows[0]?.request_count ?? limit + 1) <= limit;
}
