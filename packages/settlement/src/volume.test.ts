import { describe, expect, test } from "bun:test";
import { merkleProof, verifyProof } from "@jelly/receipts";
import type { StoredJob } from "@jelly/service";
import { usd6 } from "@jelly/shared";
import { keccak256, toBytes } from "viem";
import { MemoryFundingGraph } from "./funding-graph";
import { aggregateVolume, burnEligibleUsd6, classifyJob, dayOf, emptyTotals, jobCommitmentLeaf, jobsRootOf } from "./index";

const STUDIO = new Set(["0xstudio"]);
const NOW = 1_800_000_000_000;

function job(over: Partial<StoredJob>): StoredJob {
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
    spec: { product: "fanout" } as StoredJob["spec"],
    lines: {} as StoredJob["lines"],
    walletJob: false,
    createdAtMs: NOW,
    expiresAtSec: 0,
    amounts: { grossUsd6: usd6("2"), toolsBilledUsd6: 0n, refundUsd6: 0n },
    ...over,
  } as StoredJob;
}

const deps = (graphEdges: { from: string; to: string; atMs: number }[] = []) => ({
  studioWallets: STUDIO,
  graph: new MemoryFundingGraph(graphEdges),
});

describe("classifyJob (§8)", () => {
  test("free and credits jobs are always incentive, regardless of funder or amount", async () => {
    for (const route of ["free", "credits"] as const) {
      const j = job({ route, payer: "0xstudio", amounts: { grossUsd6: usd6("100"), toolsBilledUsd6: 0n, refundUsd6: 0n } });
      expect(await classifyJob(j, deps())).toBe("incentive");
    }
  });

  test("a job flagged as a studio test job is test, even with an outside-looking funder", async () => {
    expect(await classifyJob(job({ testJob: true }), deps())).toBe("test");
  });

  test("the studio wallet itself, or a wallet it funded, classifies as internal", async () => {
    expect(await classifyJob(job({ payer: "0xstudio" }), deps())).toBe("internal");
    const linked = deps([{ from: "0xstudio", to: "0xfunded", atMs: NOW - 1000 }]);
    expect(await classifyJob(job({ payer: "0xfunded" }), linked)).toBe("internal");
  });

  test("an outside funder paying at least $1 is real; under $1 is external_small", async () => {
    expect(await classifyJob(job({ amounts: { grossUsd6: usd6("1"), toolsBilledUsd6: 0n, refundUsd6: 0n } }), deps())).toBe("real");
    expect(await classifyJob(job({ amounts: { grossUsd6: usd6("0.99"), toolsBilledUsd6: 0n, refundUsd6: 0n } }), deps())).toBe(
      "external_small",
    );
  });

  test("the $1 threshold counts the row price and billed tools together", async () => {
    const j = job({ amounts: { grossUsd6: usd6("0.60"), toolsBilledUsd6: usd6("0.40"), refundUsd6: 0n } });
    expect(await classifyJob(j, deps())).toBe("real");
  });

  test("a job with no payer on record is never counted as real", async () => {
    const { payer, ...rest } = job({});
    void payer;
    expect(await classifyJob(rest as StoredJob, deps())).toBe("internal");
  });
});

describe("aggregateVolume and the jobs root", () => {
  test("sums classified amounts per day, product and chain, and gives each job a commitment leaf", async () => {
    const jobs = [
      job({ amounts: { grossUsd6: usd6("2"), toolsBilledUsd6: 0n, refundUsd6: 0n } }),
      job({ amounts: { grossUsd6: usd6("3"), toolsBilledUsd6: 0n, refundUsd6: 0n } }),
      job({ payer: "0xstudio", amounts: { grossUsd6: usd6("9"), toolsBilledUsd6: 0n, refundUsd6: 0n } }),
      job({ spec: { product: "trawl" } as StoredJob["spec"], amounts: { grossUsd6: usd6("1"), toolsBilledUsd6: 0n, refundUsd6: 0n } }),
    ];
    const agg = await aggregateVolume(jobs, deps());
    expect(agg.size).toBe(2); // one row for fanout/base, one for trawl/base, same day
    const fanout = agg.get(`${dayOf(NOW)}:fanout:base`)!;
    expect(fanout.totals.real).toBe(usd6("5"));
    expect(fanout.totals.internal).toBe(usd6("9"));
    expect(fanout.totals.external_small).toBe(0n);
    expect(fanout.jobKeys).toHaveLength(3);
    expect(fanout.leaves).toHaveLength(3);

    // Any later verifier can rebuild the leaf for a job it knows the bucket and gross for, and prove it against the day's root.
    const root = jobsRootOf(fanout);
    const rebuilt = jobCommitmentLeaf(fanout.jobKeys[0]!, "real", usd6("2"));
    expect(rebuilt).toBe(fanout.leaves[0]!);
    expect(verifyProof(rebuilt, merkleProof(fanout.leaves, 0), root)).toBe(true);
  });

  test("a day's totals start at zero for every bucket", () => {
    const t = emptyTotals();
    expect(Object.values(t).every((v) => v === 0n)).toBe(true);
    expect(Object.keys(t).sort()).toEqual(["external_small", "incentive", "internal", "real", "test"]);
  });

  test("only real and external_small volume counts toward the burn-eligible total", () => {
    const totals = { real: usd6("5"), external_small: usd6("0.5"), incentive: usd6("100"), internal: usd6("50"), test: usd6("9") };
    expect(burnEligibleUsd6(totals)).toBe(usd6("5.5"));
  });

  test("every job's leaf proves against the root built from the same job list", async () => {
    const jobs = Array.from({ length: 9 }, (_, i) => job({ amounts: { grossUsd6: usd6(`${i + 1}`), toolsBilledUsd6: 0n, refundUsd6: 0n } }));
    const agg = await aggregateVolume(jobs, deps());
    const day = agg.get(`${dayOf(NOW)}:fanout:base`)!;
    const root = jobsRootOf(day);
    for (let i = 0; i < day.leaves.length; i++) {
      expect(verifyProof(day.leaves[i]!, merkleProof(day.leaves, i), root)).toBe(true);
    }
  });
});
