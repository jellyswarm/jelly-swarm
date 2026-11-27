import type { JobStore, StoredJob } from "@jelly/service";
import { type MeterBucket, type Product, type Tier, formatUsd6 } from "@jelly/shared";
import { COPY } from "./copy";
import { type DailyTotals, emptyTotals } from "./volume";

/**
 * §"A public meter for real paid volume" and the M8 milestone's `/stats`:
 * real paid volume per product and chain, the studio-operator and
 * studio-checker disclosures, the refund rate, p95 per tier, and burns with
 * the job keys that funded them.
 *
 * This reads whatever the `JobStore` holds. A production deployment with
 * outside operators and burns in flight widens `StatsDeps` with those feeds
 * (`BurnRecord[]`, the operator registry) without changing this shape.
 */
export type BurnRecord = { tx: string; stableInUsd6: bigint; tokenBurned: string; jobKeys: string[] };

export type StatsDeps = {
  store: JobStore;
  /** True while every worker and checker operator is studio-run (§16 "honest limits"). */
  studioOperated: boolean;
  burns?: readonly BurnRecord[];
  jobs?: readonly StoredJob[];
};

export type VolumeRow = { product: Product; chain: string; day: string; totals: Record<MeterBucket, string> };
export type StatsView = {
  volume: VolumeRow[];
  disclosures: string[];
  refundRateBps: number;
  p95SettleSeconds: Record<Tier, number | null>;
  burns: { tx: string; stableInUsd: string; tokenBurned: string; jobKeys: string[] }[];
};

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
};

export async function buildStats(deps: StatsDeps, window: { sinceMs: number; untilMs: number }): Promise<StatsView> {
  const jobs = deps.jobs ?? (await deps.store.listAll(window.sinceMs, window.untilMs));
  const classified = jobs.filter((j) => j.meterBucket !== undefined);

  const byRow = new Map<string, VolumeRow>();
  for (const job of classified) {
    const day = new Date(job.createdAtMs).toISOString().slice(0, 10);
    const key = `${day}:${job.spec.product}:${job.chain}`;
    let row = byRow.get(key);
    if (!row) {
      row = { product: job.spec.product, chain: job.chain, day, totals: toStrings(emptyTotals()) };
      byRow.set(key, row);
    }
    const gross = (job.amounts?.grossUsd6 ?? 0n) + (job.amounts?.toolsBilledUsd6 ?? 0n);
    const bucket = job.meterBucket!;
    row.totals[bucket] = formatUsd6(usd6Of(row.totals[bucket]) + gross);
  }

  const settled = jobs.filter((j) => j.state === "settled" || j.state === "finalized" || j.state === "refunded");
  const refunded = settled.filter((j) => j.amounts && j.amounts.refundUsd6 > 0n);
  const refundRateBps = settled.length === 0 ? 0 : Math.round((refunded.length * 10_000) / settled.length);

  const p95: Record<Tier, number | null> = { open: null, standard: null, sealed: null };
  for (const tier of ["open", "standard", "sealed"] as const) {
    const latencies = jobs
      .filter((j) => j.spec.tier === tier && j.settledAtMs !== undefined)
      .map((j) => (j.settledAtMs! - j.createdAtMs) / 1000)
      .sort((a, b) => a - b);
    p95[tier] = latencies.length > 0 ? Math.round(percentile(latencies, 95)) : null;
  }

  const disclosures: string[] = [COPY.refundsOnChain];
  if (deps.studioOperated) disclosures.push(COPY.studioOperators, COPY.studioCheckers);

  return {
    volume: [...byRow.values()].sort((a, b) => a.day.localeCompare(b.day) || a.product.localeCompare(b.product)),
    disclosures,
    refundRateBps,
    p95SettleSeconds: p95,
    burns: (deps.burns ?? []).map((b) => ({ tx: b.tx, stableInUsd: formatUsd6(b.stableInUsd6), tokenBurned: b.tokenBurned, jobKeys: b.jobKeys })),
  };
}

const usd6Of = (s: string): bigint => {
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
};

const toStrings = (t: DailyTotals): Record<MeterBucket, string> =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, formatUsd6(v)])) as Record<MeterBucket, string>;
