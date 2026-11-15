import type { Escrow, JobStore } from "@jelly/service";
import { type ClassifyDeps, type KeeperEvent, SettlementKeeper } from "@jelly/settlement";

export type KeeperRunnerOptions = {
  store: JobStore;
  escrow: Escrow;
  classify: ClassifyDeps;
  /** How often to run a tick. Default 15s, matching the pool-manager cadence elsewhere in the system. */
  intervalMs?: number;
  onEvent?: (e: KeeperEvent) => void;
};

/**
 * Runs the settlement-keeper on an interval. This file is the thin runtime
 * wrapper (§7 "services"); all of its logic lives in `@jelly/settlement`,
 * which is what tests exercise directly.
 */
export function startKeeper(opts: KeeperRunnerOptions): { stop: () => void } {
  const keeper = new SettlementKeeper({ store: opts.store, escrow: opts.escrow, classify: opts.classify, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}) });
  const timer = setInterval(() => {
    keeper.tick().catch((e) => console.error("settlement-keeper tick failed", e));
  }, opts.intervalMs ?? 15_000);
  return { stop: () => clearInterval(timer) };
}

export { SettlementKeeper } from "@jelly/settlement";
