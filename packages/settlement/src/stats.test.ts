import { describe, expect, test } from "bun:test";
import { MemoryJobStore, type StoredJob } from "@jelly/service";
import type { JobSpec, PriceLines } from "@jelly/engine";
import { usd6 } from "@jelly/shared";
import { keccak256, toBytes } from "viem";
import { buildStats, SETTLEMENT_COPY } from "./index";

const NOW = 1_800_000_000_000;

function job(bucket: string, over: Partial<StoredJob> = {}): StoredJob {
  return {
    jobKey: keccak256(toBytes(`job-${Math.random()}`)),
    jobId: 1n,
    quoteId: "q",
    accountId: "a",
    accountTier: "paid",
    chain: "base",
    state: "finalized",
    route: "wallet",
    lane: "paid",
    payer: "0xoutside",
    spec: { product: "fanout", tier: "standard" } as JobSpec,
    lines: {} as PriceLines,
    walletJob: false,
    createdAtMs: NOW,
    settledAtMs: NOW + 5000,
    expiresAtSec: 0,
    meterBucket: bucket as StoredJob["meterBucket"],
    amounts: { grossUsd6: usd6("2"), toolsBilledUsd6: 0n, refundUsd6: 0n },
    ...over,
  } as StoredJob;
}

/** For a job that has not been classified, or has not settled: omits the key entirely, since exactOptionalPropertyTypes forbids setting it to `undefined`. */
function withoutKeys<K extends keyof StoredJob>(j: StoredJob, ...keys: K[]): StoredJob {
  const copy = { ...j };
  for (const k of keys) delete copy[k];
  return copy;
}

async function storeWith(jobs: StoredJob[]): Promise<MemoryJobStore> {
  const store = new MemoryJobStore(() => NOW);
  for (const j of jobs) await store.putJob(j);
  return store;
}

describe("buildStats (§ 'a public meter for real paid volume')", () => {
  test("sums classified volume per day, product and chain, formatted as dollar strings", async () => {
    const store = await storeWith([
      job("real", { amounts: { grossUsd6: usd6("2"), toolsBilledUsd6: 0n, refundUsd6: 0n } }),
      job("real", { amounts: { grossUsd6: usd6("3"), toolsBilledUsd6: 0n, refundUsd6: 0n } }),
      job("incentive", { amounts: { grossUsd6: usd6("0.25"), toolsBilledUsd6: 0n, refundUsd6: 0n } }),
    ]);
    const view = await buildStats({ store, studioOperated: true }, { sinceMs: NOW - 1000, untilMs: NOW + 1000 });
    expect(view.volume).toHaveLength(1);
    expect(view.volume[0]).toMatchObject({ product: "fanout", chain: "base", totals: { real: "5.00", incentive: "0.25", internal: "0.00" } });
  });

  test("an unclassified job contributes no volume row", async () => {
    const store = await storeWith([withoutKeys(job("real"), "meterBucket")]);
    const view = await buildStats({ store, studioOperated: true }, { sinceMs: NOW - 1000, untilMs: NOW + 1000 });
    expect(view.volume).toEqual([]);
  });

  test("the studio-operator and studio-checker disclosures show only while we run every operator", async () => {
    const store = await storeWith([]);
    const studio = await buildStats({ store, studioOperated: true }, { sinceMs: 0, untilMs: NOW });
    expect(studio.disclosures).toContain(SETTLEMENT_COPY.studioOperators);
    expect(studio.disclosures).toContain(SETTLEMENT_COPY.studioCheckers);
    const outside = await buildStats({ store, studioOperated: false }, { sinceMs: 0, untilMs: NOW });
    expect(outside.disclosures).not.toContain(SETTLEMENT_COPY.studioOperators);
    expect(outside.disclosures).toContain(SETTLEMENT_COPY.refundsOnChain); // always shown
  });

  test("refund rate counts jobs with any refund against every settled job", async () => {
    const store = await storeWith([
      job("real", { amounts: { grossUsd6: usd6("2"), toolsBilledUsd6: 0n, refundUsd6: 0n } }),
      job("real", { amounts: { grossUsd6: usd6("1"), toolsBilledUsd6: 0n, refundUsd6: usd6("1") } }),
      job("real", { state: "refunded", amounts: { grossUsd6: 0n, toolsBilledUsd6: 0n, refundUsd6: usd6("3") } }),
      withoutKeys(job("real", { state: "running" }), "amounts"), // not yet settled: excluded from the rate
    ]);
    const view = await buildStats({ store, studioOperated: true }, { sinceMs: NOW - 1000, untilMs: NOW + 1000 });
    expect(view.refundRateBps).toBe(6667); // 2 of 3 settled jobs carried a refund
  });

  test("p95 settle time is computed per tier, from jobs that have actually settled", async () => {
    const latencies = [1, 2, 3, 4, 100]; // seconds
    const store = await storeWith(latencies.map((s) => job("real", { settledAtMs: NOW + s * 1000 })));
    const view = await buildStats({ store, studioOperated: true }, { sinceMs: NOW - 1000, untilMs: NOW + 1000 });
    expect(view.p95SettleSeconds.standard).toBe(100);
    expect(view.p95SettleSeconds.open).toBeNull(); // no jobs on that tier
  });

  test("burns are passed through with the job keys that funded them", async () => {
    const store = await storeWith([]);
    const view = await buildStats(
      { store, studioOperated: true, burns: [{ tx: "0xburn", stableInUsd6: usd6("10"), tokenBurned: "1000", jobKeys: ["0xa", "0xb"] }] },
      { sinceMs: 0, untilMs: NOW },
    );
    expect(view.burns).toEqual([{ tx: "0xburn", stableInUsd: "10.00", tokenBurned: "1000", jobKeys: ["0xa", "0xb"] }]);
  });

  test("jobs outside the requested window are excluded", async () => {
    const store = await storeWith([job("real", { createdAtMs: NOW - 100_000 })]);
    const view = await buildStats({ store, studioOperated: true }, { sinceMs: NOW - 1000, untilMs: NOW + 1000 });
    expect(view.volume).toEqual([]);
  });
});
