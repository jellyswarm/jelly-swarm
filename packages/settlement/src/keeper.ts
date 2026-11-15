import type { Escrow, JobStore, StoredJob } from "@jelly/service";
import { needsAudit, sampleRows } from "./audit";
import { type ClassifyDeps, classifyJob } from "./volume";

export type KeeperDeps = {
  store: JobStore;
  escrow: Escrow;
  classify: ClassifyDeps;
  now?: () => number;
  onEvent?: (e: KeeperEvent) => void;
};

export type KeeperEvent =
  | { type: "audit_opened"; jobKey: `0x${string}`; roundId: bigint }
  | { type: "audit_skipped"; jobKey: `0x${string}` }
  | { type: "finalized"; jobKey: `0x${string}`; tx: string }
  | { type: "classified"; jobKey: `0x${string}`; bucket: string }
  | { type: "keeper_error"; jobKey: `0x${string}`; error: unknown };

/**
 * §3.3 step 8-9 and §8. Runs the two things nothing else in the system does
 * once a job is settled on-chain: decide whether it gets an independent
 * audit, and release the held amount once the dispute window is closed and
 * every round on it has resolved. It also classifies finished jobs for the
 * volume meter, so `/stats` and the daily on-chain post have something to
 * read.
 *
 * `tick()` is one pass over every job that needs attention; call it on an
 * interval (apps/keeper does this) or once per test. It is safe to call
 * concurrently with itself: every write is conditional on the state it
 * expects, so a job already moved on by another pass is simply skipped.
 */
export class SettlementKeeper {
  private readonly now: () => number;

  constructor(private readonly deps: KeeperDeps) {
    this.now = deps.now ?? Date.now;
  }

  async tick(): Promise<void> {
    for (const job of await this.deps.store.listAwaitingFinalize()) {
      await this.handle(job).catch((error) => this.deps.onEvent?.({ type: "keeper_error", jobKey: job.jobKey, error }));
    }
  }

  private async handle(job: StoredJob): Promise<void> {
    const { store, escrow } = this.deps;
    const releaseAtSec = job.releaseAtSec;
    if (releaseAtSec === undefined) return; // not yet settled on-chain from this process's point of view

    if (job.auditDecision === undefined) {
      const gross = (job.amounts?.grossUsd6 ?? 0n) + (job.amounts?.toolsBilledUsd6 ?? 0n);
      const stillOpen = this.now() / 1000 < releaseAtSec;
      if (stillOpen && needsAudit(job.jobKey, gross)) {
        const rowIdx = sampleRows((job.rows ?? []).map((r) => r.state));
        const { roundId } = await escrow.openAuditRound(job.jobId, rowIdx);
        await store.updateJob(job.jobKey, { auditDecision: "audited", auditRoundId: roundId });
        this.deps.onEvent?.({ type: "audit_opened", jobKey: job.jobKey, roundId });
        return; // finalize waits for the round regardless; next tick checks it
      }
      await store.updateJob(job.jobKey, { auditDecision: "skipped" });
      this.deps.onEvent?.({ type: "audit_skipped", jobKey: job.jobKey });
    }

    if (this.now() / 1000 < releaseAtSec) return;
    if ((await escrow.roundsOpen(job.jobId)) > 0) return;

    const { tx } = await escrow.finalize(job.jobId);
    await store.updateJob(job.jobKey, { state: "finalized", finalizeTx: tx, finalizedAtMs: this.now() });
    this.deps.onEvent?.({ type: "finalized", jobKey: job.jobKey, tx });
  }
}

export type VolumeClassifierDeps = { store: JobStore; classify: ClassifyDeps; now?: () => number; onEvent?: (e: KeeperEvent) => void };

/**
 * §8 the daily volume classifier (apps/meter). Separate from
 * `SettlementKeeper` because it never touches the escrow: it only reads
 * finished jobs and writes their bucket back to the store.
 */
export class VolumeClassifier {
  private readonly now: () => number;

  constructor(private readonly deps: VolumeClassifierDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Classifies every finished job in `[sinceMs, untilMs)` that has not been classified yet. */
  async classifyWindow(sinceMs: number, untilMs: number): Promise<void> {
    for (const job of await this.deps.store.listForVolume(sinceMs, untilMs)) {
      const bucket = await classifyJob(job, this.deps.classify);
      await this.deps.store.updateJob(job.jobKey, { meterBucket: bucket, volumeRecordedAtMs: this.now() });
      this.deps.onEvent?.({ type: "classified", jobKey: job.jobKey, bucket });
    }
  }
}
