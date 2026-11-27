import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { StoredJob, StoredQuote } from "@jelly/service";
import { loadInfraEnv } from "@jelly/shared";
import type { Hex } from "viem";
import { createDb, schema } from "./index";
import { PgJobStore } from "./job-store";
import { runMigrations } from "./migrate";

const url = loadInfraEnv().DATABASE_URL;

// A fresh, short-lived connection per check/test: the Railway proxy this points
// at in dev can drop a pooled connection that sits idle across a migration run,
// so a single long-lived pool held open for the whole file is not reliable here.
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

describe.skipIf(!reachable)("PgJobStore against Postgres", () => {
  // High latency to a remote dev Postgres (Railway proxy): the default 5s bun-test timeout is too tight.
  test("quote, job, event, share, referral and credit round-trip", async () => {
    await runMigrations(url);
    const { db, close } = createDb(url, { max: 2 });
    const store = new PgJobStore(db);

    const [account] = await db.insert(schema.accounts).values({ tier: "paid" }).returning({ id: schema.accounts.id });
    const accountId = account!.id;

    const jobKey = `0x${randomUUID().replace(/-/g, "")}${"0".repeat(24)}`.slice(0, 66) as Hex;
    const spec = {
      product: "fanout" as const,
      task: "test task",
      items: [{ raw: "tok-0", kind: "text" as const }],
      columns: [{ name: "holders", type: "number" as const, needsSource: false }],
      tier: "standard" as const,
      maxAgents: 1,
    };
    const quote: StoredQuote = {
      id: randomUUID(),
      accountId,
      chain: "base",
      pricebookKey: "fanout.job",
      quote: {
        specHash: "0xabc" as Hex,
        units: 1,
        unitUsd6: 5000n,
        baseUsd6: 250_000n,
        toolsCapUsd6: 0n,
        tier: 0,
        maxAgents: 1,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 600),
        chain: "0xdef" as Hex,
      },
      signature: "0x00" as Hex,
      lines: {
        pricebookKey: "fanout.job" as const,
        tier: "standard",
        units: 1,
        agents: 1,
        waves: 1,
        unitUsd6: 5000n,
        baseUsd6: 250_000n,
        rowsUsd6: 5000n,
        toolsCapUsd6: 0n,
        totalUsd6: 255_000n,
      },
      spec,
      walletJob: false,
      tierForced: false,
      createdAtMs: Date.now(),
    };
    await store.putQuote(quote);
    expect(await store.getQuote(quote.id)).toEqual(quote);

    const job: StoredJob = {
      jobKey,
      jobId: BigInt(Date.now()),
      quoteId: quote.id,
      accountId,
      accountTier: "paid",
      chain: "base",
      state: "awaiting_payment",
      route: "wallet",
      lane: "paid",
      spec,
      lines: quote.lines,
      walletJob: false,
      createdAtMs: Date.now(),
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    };
    await store.putJob(job);
    expect(await store.getJob(jobKey)).toEqual(job);
    expect(await store.getJobByQuote(quote.id)).toEqual(job);

    const updated = await store.updateJob(jobKey, { state: "running" });
    expect(updated.state).toBe("running");
    expect((await store.getJob(jobKey))!.state).toBe("running");

    const listed = await store.listJobs(accountId, 10);
    expect(listed.map((j) => j.jobKey)).toContain(jobKey);

    const e1 = await store.appendEvent(jobKey, "job.started", { ok: true });
    expect(e1.seq).toBe(1);
    const e2 = await store.appendEvent(jobKey, "job.progress", { n: 2 });
    expect(e2.seq).toBe(2);
    const since = await store.eventsSince(jobKey, 0, 10);
    expect(since.map((e) => e.seq)).toEqual([1, 2]);

    const code = `ref-${randomUUID().slice(0, 8)}`;
    await store.putReferralCode(accountId, code);
    expect(await store.getReferralCode(accountId)).toBe(code);
    expect(await store.getAccountForReferralCode(code)).toBe(accountId);

    const [referee] = await db.insert(schema.accounts).values({ tier: "free" }).returning({ id: schema.accounts.id });
    const referral = {
      id: randomUUID(),
      refCode: code,
      referrerAccountId: accountId,
      refereeAccountId: referee!.id,
      state: "pending" as const,
      createdAtMs: Date.now(),
    };
    await store.putReferral(referral);
    expect(await store.getReferralByReferee(referee!.id)).toEqual(referral);
    const paidReferral = await store.updateReferral(referral.id, { state: "paid" });
    expect(paidReferral.state).toBe("paid");
    expect(await store.countPaidReferralsSince(accountId, referral.createdAtMs - 1000)).toBe(1);

    await store.addCredit({ id: randomUUID(), accountId, deltaUsd6: 1_000_000n, reason: "referral_referrer", createdAtMs: Date.now() });
    expect(await store.creditBalance(accountId, Date.now())).toBe(1_000_000n);

    const slug = `share-${randomUUID().slice(0, 8)}`;
    await store.putShare({
      slug,
      jobKey,
      accountId,
      visibility: "private",
      snapshot: { csv: "a,b", markdown: "# x", manifest: { jobKey } },
      createdAtMs: Date.now(),
    });
    expect((await store.getShare(slug))!.visibility).toBe("private");
    await store.updateShare(slug, { visibility: "public" });
    expect((await store.getShare(slug))!.visibility).toBe("public");
    expect((await store.listSharesForJob(jobKey)).map((s) => s.slug)).toContain(slug);

    await store.putDispute({ id: randomUUID(), jobKey, accountId, rowIdx: [0], feeUsd6: 500_000n, evidence: "proof", createdAtMs: Date.now() });

    const apiKeyId = `key-${randomUUID().slice(0, 8)}`;
    const secretHash = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await store.putApiKey({ keyId: apiKeyId, secretHash, accountId, owner: "0xdead", active: true, createdAtMs: Date.now() });
    const key = await store.getApiKeyByHash(secretHash);
    expect(key?.keyId).toBe(apiKeyId);
    expect(key?.active).toBe(true);

    await close();
  }, 30_000);
});
