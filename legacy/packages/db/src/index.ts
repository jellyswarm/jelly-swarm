import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";
export * from "./account-store";
export * from "./job-store";
export * from "./session-store";
export * from "./watch-store";

export type Db = ReturnType<typeof createDb>["db"];

/**
 * Opens a connection pool. Call `close()` on shutdown.
 *
 * `prepare: false` disables postgres.js's default use of named prepared
 * statements: many managed Postgres proxies (PgBouncer and similar, in
 * transaction- or statement-pooling mode — the usual setup behind a single
 * TCP endpoint for many short-lived app connections) don't preserve a
 * prepared statement across the physical connections they hand out, which
 * can silently hang a later query rather than error. Simple-query mode has
 * no such statement to lose.
 */
export function createDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {}, prepare: false });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}
