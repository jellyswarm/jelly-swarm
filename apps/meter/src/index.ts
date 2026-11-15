import type { JobStore } from "@jelly/service";
import { type ClassifyDeps, VolumeClassifier } from "@jelly/settlement";

export type MeterRunnerOptions = {
  store: JobStore;
  classify: ClassifyDeps;
  now?: () => number;
  /** How many days back to re-scan for not-yet-classified jobs, in case a run was missed. */
  lookbackDays?: number;
};

/**
 * Daily volume classification (§8). The thin runtime wrapper around
 * `VolumeClassifier`; the classification rules themselves live in
 * `@jelly/settlement` and are what tests exercise directly.
 *
 * Posting the result on-chain (`VolumeMeter.post` / `jelly_sol.post_meter`)
 * needs the chain clients from the settlement-keeper's deployment and is
 * added once those are wired up; this runner prepares the classified rows
 * that call would post.
 */
export async function runDaily(opts: MeterRunnerOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const classifier = new VolumeClassifier({ store: opts.store, classify: opts.classify, now });
  const untilMs = now();
  const sinceMs = untilMs - (opts.lookbackDays ?? 2) * 24 * 3600 * 1000;
  await classifier.classifyWindow(sinceMs, untilMs);
}

export { VolumeClassifier } from "@jelly/settlement";

if (import.meta.main) {
  console.error("apps/meter needs a JobStore and a FundingGraph wired to the chain indexer; see @jelly/settlement for the classification logic.");
  process.exit(1);
}
