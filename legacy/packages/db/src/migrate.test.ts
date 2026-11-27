import { afterAll, describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { sql } from "drizzle-orm";
import { createDb, schema } from "./index";
import { runMigrations } from "./migrate";

/**
 * Needs the docker-compose Postgres (`pnpm infra:up`). Skipped when it is not
 * reachable, unless REQUIRE_INFRA=1 (set in CI), in which case it fails.
 */
const url = loadInfraEnv().DATABASE_URL;
const { db, client, close } = createDb(url, { max: 2 });

const reachable = await client`select 1`.then(
  () => true,
  () => false,
);
if (!reachable && process.env.REQUIRE_INFRA === "1") {
  throw new Error(`REQUIRE_INFRA=1 but Postgres is not reachable at ${url}`);
}

afterAll(close);

describe.skipIf(!reachable)("migrations against Postgres", () => {
  test("apply cleanly and are idempotent", async () => {
    await runMigrations(url);
    await runMigrations(url);
    const found = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = found.map((r) => r.table_name);
    for (const t of ["accounts", "quotes", "jobs", "rows", "receipts", "burns", "x402_payments"]) {
      expect(names).toContain(t);
    }
  });

  const quote = (maxAgents: number) => ({
    spec: {},
    specHash: "0x00",
    product: "fanout",
    tier: "open",
    chain: "base",
    units: 300,
    maxAgents,
    unitUsd6: 5_000n,
    baseUsd6: 250_000n,
    toolsCapUsd6: 0n,
    estCostUsd6: 330_000n,
    signature: "0x00",
    expiresAt: new Date(Date.now() + 600_000),
    extra: {},
  });

  test("the database refuses a quote above 247 agents", async () => {
    // Not `expect(db.insert(...)).rejects.toThrow()`: Bun's `rejects` matcher doesn't await a
    // drizzle query builder's own thenable correctly, so it never actually ran the query. Wrapping
    // it in a real `async` IIFE gives `expect` a native Promise instead.
    await expect(
      (async () => {
        await db.insert(schema.quotes).values(quote(248));
      })(),
    ).rejects.toThrow();
  });

  test("money round-trips as bigint", async () => {
    const [row] = await db.insert(schema.quotes).values(quote(247)).returning();
    expect(row?.unitUsd6).toBe(5_000n);
    expect(row?.baseUsd6).toBe(250_000n);
    await db.delete(schema.quotes).where(sql`${schema.quotes.id} = ${row!.id}`);
  });
});
