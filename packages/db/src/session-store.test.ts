import { describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { createDb, schema } from "./index";
import { runMigrations } from "./migrate";
import { PgSessionStore } from "./session-store";

const url = loadInfraEnv().DATABASE_URL;

async function ping(): Promise<boolean> {
  const { client, close } = createDb(url, { max: 1 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

const reachable = await ping();
if (!reachable && process.env.REQUIRE_INFRA === "1") {
  throw new Error(`REQUIRE_INFRA=1 but Postgres is not reachable at ${url}`);
}

describe.skipIf(!reachable)("PgSessionStore against Postgres", () => {
  test("create, get and revoke", async () => {
    await runMigrations(url);
    const { db, close } = createDb(url, { max: 2 });
    const store = new PgSessionStore(db);

    const [account] = await db.insert(schema.accounts).values({ tier: "free" }).returning();
    const session = await store.create(account!.id, undefined, Date.now(), 60_000);
    expect((await store.get(session.id))?.accountId).toBe(account!.id);

    await store.revoke(session.id);
    expect(await store.get(session.id)).toBeUndefined();

    await close();
  }, 30_000);
});
