import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

/** Opens a connection pool. Call `close()` on shutdown. */
export function createDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}
