import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { pool } from "./index";

const migrationDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

export async function migrate(database: Pool = pool): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const filename of files) {
    const alreadyApplied = await database.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
    if (alreadyApplied.rowCount) continue;

    const sql = await readFile(join(migrationDirectory, filename), "utf8");
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

if (import.meta.main) {
  try {
    await migrate();
    console.info("database migrations applied");
  } finally {
    await pool.end();
  }
}
