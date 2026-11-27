import { merkleRoot } from "@jelly/receipts";
import type { StoredJob } from "@jelly/service";
import { type Product, VOLUME, isBurnEligible } from "@jelly/shared";
import type { MeterBucket } from "@jelly/shared";
import { type Hex, hashTypedData } from "viem";
import type { FundingGraph } from "./funding-graph";

/**
 * §8 volume classification. The on-chain rule (§0.4 "checker family from
 * the workers") is already enforced before a job can ever reach "settled"
 * or "finalized", so the only things left to decide here are: is the funder
 * really outside the studio, and is the amount at least $1 (§8 and the
 * Overview's /stats definition).
 *
 *   incentive  the free tier or a credit-funded job (never counted as real,
 *              never burn-eligible — §10.3)
 *   test       a job the studio ran for its own QA, flagged as such
 *   internal   the funder is a studio wallet, or was funded by one within
 *              3 hops over the last 30 days ("studio-linked funder")
 *   real       an outside funder, gross at least $1
 *   external_small  an outside funder, gross under $1 (burn-eligible, but
 *              never counted as real paid volume)
 */
export type ClassifyDeps = { studioWallets: ReadonlySet<string>; graph: FundingGraph; now?: () => number };

export async function classifyJob(job: StoredJob, deps: ClassifyDeps): Promise<MeterBucket> {
  if (job.route === "free" || job.route === "credits") return "incentive";
  if (job.testJob) return "test";

  const funder = job.payer;
  const gross = (job.amounts?.grossUsd6 ?? 0n) + (job.amounts?.toolsBilledUsd6 ?? 0n);
  const atMs = job.createdAtMs;
  if (!funder || (await deps.graph.isStudioLinked(funder, deps.studioWallets, VOLUME.fundingHops, VOLUME.fundingLookbackMs, atMs))) {
    return "internal";
  }
  return gross >= VOLUME.realMinUsd6 ? "real" : "external_small";
}

export type DailyTotals = Record<MeterBucket, bigint>;
export const emptyTotals = (): DailyTotals => ({ real: 0n, external_small: 0n, incentive: 0n, internal: 0n, test: 0n });

export type DailyKey = { day: string; product: Product; chain: string };
export type DailyAggregate = DailyKey & { totals: DailyTotals; jobKeys: Hex[]; leaves: Hex[] };

/** UTC day (YYYY-MM-DD) a job's volume is attributed to: when it was created, not when it settled. */
export const dayOf = (createdAtMs: number): string => new Date(createdAtMs).toISOString().slice(0, 10);

/**
 * Classifies and sums a batch of finished jobs into one row per
 * (day, product, chain), ready for `VolumeMeter.Day` / `jelly_sol.post_meter`.
 */
export async function aggregateVolume(jobs: readonly StoredJob[], deps: ClassifyDeps): Promise<Map<string, DailyAggregate>> {
  const out = new Map<string, DailyAggregate>();
  for (const job of jobs) {
    const bucket = job.meterBucket ?? (await classifyJob(job, deps));
    const key: DailyKey = { day: dayOf(job.createdAtMs), product: job.spec.product, chain: job.chain };
    const mapKey = `${key.day}:${key.product}:${key.chain}`;
    let agg = out.get(mapKey);
    if (!agg) {
      agg = { ...key, totals: emptyTotals(), jobKeys: [], leaves: [] };
      out.set(mapKey, agg);
    }
    const gross = (job.amounts?.grossUsd6 ?? 0n) + (job.amounts?.toolsBilledUsd6 ?? 0n);
    agg.totals[bucket] += gross;
    agg.jobKeys.push(job.jobKey);
    agg.leaves.push(jobCommitmentLeaf(job.jobKey, bucket, gross));
  }
  return out;
}

/** The `jobsRoot` field of `VolumeMeter.Day` / `jelly_sol.post_meter`: a Merkle root over that day's job commitments. */
export const jobsRootOf = (agg: Pick<DailyAggregate, "leaves">): Hex => merkleRoot(agg.leaves);

/** §4-style job-list commitment: a job's key and classified amount, hashed into one leaf per job. */
export function jobCommitmentLeaf(jobKey: Hex, bucket: MeterBucket, grossUsd6: bigint): Hex {
  return hashTypedData({
    domain: { name: "JellySwarm VolumeMeter", version: "1" },
    types: { Commitment: [{ name: "jobKey", type: "bytes32" }, { name: "bucket", type: "string" }, { name: "grossUsd6", type: "uint64" }] },
    primaryType: "Commitment",
    message: { jobKey, bucket, grossUsd6 },
  });
}

export const burnEligibleUsd6 = (totals: DailyTotals): bigint =>
  (Object.entries(totals) as [MeterBucket, bigint][]).reduce((sum, [bucket, amount]) => (isBurnEligible(bucket) ? sum + amount : sum), 0n);
