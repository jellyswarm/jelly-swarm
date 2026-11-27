import { ACCOUNT_CONCURRENCY, type AccountTier, LANE_PRIORITY, type Lane, MAX_AGENTS } from "@jelly/shared";
import { type Wave, planWaves } from "./waves";

/**
 * §12.3 fair-use scheduler. Decides which row runs next across every job.
 *
 * - Lanes are strict priorities: priority, then paid, then free, then deferred.
 * - Inside a lane, accounts take turns by deficit round-robin, so one heavy
 *   account cannot starve the others.
 * - Each job runs at most its wave width (never above 247) at once, one wave
 *   at a time.
 * - Each account runs a limited number of jobs at once (free 1, paid 5,
 *   holders 10); further jobs wait their turn.
 * - `globalAgents` caps rows in flight across all jobs.
 *
 * State is in this process. A row is handed out by `next()` and must be
 * returned with `complete()`.
 */
export type SchedJob = {
  jobKey: string;
  accountId: string;
  accountTier: AccountTier;
  lane: Lane;
  rows: number;
  /** The job's own concurrency, 1..247. */
  maxAgents: number;
};

export type Dispatch = {
  jobKey: string;
  accountId: string;
  lane: Lane;
  rowIdx: number;
  /** 0 for the first try, 1 for the single retry. */
  attempt: number;
  wave: number;
};

export type SchedulerEvents = {
  onWaveStarted?: (jobKey: string, wave: Wave) => void;
  onJobActivated?: (jobKey: string) => void;
};

type Queued = { rowIdx: number; attempt: number };

type JobState = SchedJob & {
  waves: Wave[];
  waveIdx: number;
  queue: Queued[];
  /** Rows of the current wave not yet final (queued or in flight). */
  openInWave: number;
  inFlight: number;
  widthFactor: number;
  active: boolean;
  /** Rows not yet final across the whole job. */
  openRows: number;
};

type AccountLane = { deficit: number; inTurn: boolean; jobs: string[]; cursor: number };
type LaneState = { accounts: Map<string, AccountLane>; ring: string[]; ptr: number };

const LANES = (Object.keys(LANE_PRIORITY) as Lane[]).sort((a, b) => LANE_PRIORITY[a] - LANE_PRIORITY[b]);

export class Scheduler {
  private readonly jobs = new Map<string, JobState>();
  private readonly lanes = new Map<Lane, LaneState>(LANES.map((l) => [l, { accounts: new Map(), ring: [], ptr: 0 }]));
  /** Jobs running per account, and jobs waiting for a slot. */
  private readonly activeByAccount = new Map<string, number>();
  private readonly pendingByAccount = new Map<string, string[]>();
  private inFlight = 0;
  private readonly quantum: number;

  constructor(
    private readonly opts: { globalAgents: number; quantum?: number; p50RowMs?: number },
    private readonly events: SchedulerEvents = {},
  ) {
    if (!Number.isInteger(opts.globalAgents) || opts.globalAgents < 1) throw new Error("globalAgents must be >= 1");
    this.quantum = opts.quantum ?? 8;
  }

  get rowsInFlight(): number {
    return this.inFlight;
  }

  submit(job: SchedJob): void {
    if (this.jobs.has(job.jobKey)) throw new Error(`job already scheduled: ${job.jobKey}`);
    if (!Number.isInteger(job.maxAgents) || job.maxAgents < 1 || job.maxAgents > MAX_AGENTS) {
      throw new Error(`maxAgents must be between 1 and ${MAX_AGENTS}`);
    }
    const state: JobState = {
      ...job,
      waves: planWaves(job.rows),
      waveIdx: -1,
      queue: [],
      openInWave: 0,
      inFlight: 0,
      widthFactor: 1,
      active: false,
      openRows: job.rows,
    };
    this.jobs.set(job.jobKey, state);
    const running = this.activeByAccount.get(job.accountId) ?? 0;
    if (running < ACCOUNT_CONCURRENCY[job.accountTier]) this.activate(state);
    else this.pendingByAccount.set(job.accountId, [...(this.pendingByAccount.get(job.accountId) ?? []), job.jobKey]);
  }

  private activate(job: JobState): void {
    job.active = true;
    this.activeByAccount.set(job.accountId, (this.activeByAccount.get(job.accountId) ?? 0) + 1);
    const lane = this.lanes.get(job.lane)!;
    let acct = lane.accounts.get(job.accountId);
    if (!acct) {
      acct = { deficit: 0, inTurn: false, jobs: [], cursor: 0 };
      lane.accounts.set(job.accountId, acct);
      lane.ring.push(job.accountId);
    }
    acct.jobs.push(job.jobKey);
    this.events.onJobActivated?.(job.jobKey);
    this.startNextWave(job);
  }

  private startNextWave(job: JobState): void {
    job.waveIdx++;
    const wave = job.waves[job.waveIdx];
    if (!wave) return;
    job.queue = Array.from({ length: wave.to - wave.from + 1 }, (_, i) => ({ rowIdx: wave.from + i, attempt: 0 }));
    job.openInWave = job.queue.length;
    this.events.onWaveStarted?.(job.jobKey, wave);
  }

  private width(job: JobState): number {
    return Math.max(1, Math.floor(job.maxAgents * job.widthFactor));
  }

  /** The next row to run, or null if nothing can start right now. */
  next(): Dispatch | null {
    if (this.inFlight >= this.opts.globalAgents) return null;
    for (const lane of LANES) {
      const d = this.nextInLane(lane);
      if (d) return d;
    }
    return null;
  }

  private nextInLane(laneKey: Lane): Dispatch | null {
    const lane = this.lanes.get(laneKey)!;
    // Each account gets at most one fresh turn per call; two passes let the
    // account that just ended its turn be reached again after the others.
    for (let visited = 0; visited < lane.ring.length * 2 && lane.ring.length > 0; visited++) {
      lane.ptr %= lane.ring.length;
      const accountId = lane.ring[lane.ptr]!;
      const acct = lane.accounts.get(accountId)!;
      if (!acct.inTurn) {
        acct.deficit += this.quantum;
        acct.inTurn = true;
      }
      const job = acct.deficit >= 1 ? this.pickJob(acct) : undefined;
      if (job) {
        acct.deficit -= 1;
        const q = job.queue.shift()!;
        job.inFlight++;
        this.inFlight++;
        return {
          jobKey: job.jobKey,
          accountId,
          lane: laneKey,
          rowIdx: q.rowIdx,
          attempt: q.attempt,
          wave: job.waveIdx,
        };
      }
      // Turn over: out of deficit, or nothing this account can start now.
      if (acct.deficit >= 1) acct.deficit = 0;
      acct.inTurn = false;
      lane.ptr++;
    }
    return null;
  }

  /** Round-robin over the account's running jobs for one with a row it may start. */
  private pickJob(acct: AccountLane): JobState | undefined {
    for (let i = 0; i < acct.jobs.length; i++) {
      const idx = (acct.cursor + i) % acct.jobs.length;
      const job = this.jobs.get(acct.jobs[idx]!)!;
      if (job.queue.length > 0 && job.inFlight < this.width(job)) {
        acct.cursor = (idx + 1) % acct.jobs.length;
        return job;
      }
    }
    return undefined;
  }

  /**
   * Returns a row. "retry" puts it back at the front of its wave for its one
   * retry; "final" closes it (passed or refunded).
   */
  complete(jobKey: string, rowIdx: number, outcome: "final" | "retry"): void {
    const job = this.jobs.get(jobKey);
    if (!job) return;
    job.inFlight--;
    this.inFlight--;
    if (outcome === "retry") {
      job.queue.unshift({ rowIdx, attempt: 1 });
      return;
    }
    job.openInWave--;
    job.openRows--;
    if (job.openInWave === 0) this.startNextWave(job);
    if (job.openRows === 0) this.finish(job);
  }

  /** §2.3: the heartbeat halves the wave width when the quote is running low. */
  setWidthFactor(jobKey: string, factor: number): void {
    const job = this.jobs.get(jobKey);
    if (job && factor > 0) job.widthFactor = Math.min(1, factor);
  }

  /**
   * Removes every row of the job that has not started, in this and later
   * waves, and returns them so the caller can mark them refunded. Rows in
   * flight are unaffected and must still be completed.
   */
  drain(jobKey: string): number[] {
    const job = this.jobs.get(jobKey);
    if (!job) return [];
    const dropped = job.queue.map((q) => q.rowIdx);
    for (let w = job.waveIdx + 1; w < job.waves.length; w++) {
      const wave = job.waves[w]!;
      for (let r = wave.from; r <= wave.to; r++) dropped.push(r);
    }
    job.queue = [];
    job.waveIdx = job.waves.length;
    job.openRows -= dropped.length;
    job.openInWave = job.inFlight;
    if (job.openRows === 0) this.finish(job);
    return dropped;
  }

  private finish(job: JobState): void {
    this.jobs.delete(job.jobKey);
    if (!job.active) {
      const pending = (this.pendingByAccount.get(job.accountId) ?? []).filter((k) => k !== job.jobKey);
      this.pendingByAccount.set(job.accountId, pending);
      return;
    }
    const lane = this.lanes.get(job.lane)!;
    const acct = lane.accounts.get(job.accountId);
    if (acct) {
      acct.jobs = acct.jobs.filter((k) => k !== job.jobKey);
      acct.cursor = 0;
      if (acct.jobs.length === 0) {
        lane.accounts.delete(job.accountId);
        const at = lane.ring.indexOf(job.accountId);
        lane.ring.splice(at, 1);
        if (at < lane.ptr) lane.ptr--;
      }
    }
    this.activeByAccount.set(job.accountId, (this.activeByAccount.get(job.accountId) ?? 1) - 1);
    const pending = this.pendingByAccount.get(job.accountId) ?? [];
    const nextKey = pending.shift();
    if (nextKey) this.activate(this.jobs.get(nextKey)!);
  }

  isScheduled(jobKey: string): boolean {
    return this.jobs.has(jobKey);
  }

  /** Rows waiting (not in flight) in this lane and every lane that runs before it. */
  queuedAhead(lane: Lane): number {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (LANE_PRIORITY[job.lane] <= LANE_PRIORITY[lane]) n += job.openRows - job.inFlight;
    }
    return n;
  }

  /**
   * §12.3 admission control: ETA = lane depth × p50 row time, spread over the
   * global capacity. Load changes the wait, never the price.
   */
  admission(lane: Lane): { etaSec: number; freeMode: "open" | "queue" | "paused" } {
    const p50 = this.opts.p50RowMs ?? 20_000;
    const etaSec = Math.ceil((this.queuedAhead(lane) * p50) / this.opts.globalAgents / 1000);
    const freeEta = lane === "free" ? etaSec : this.admissionEta("free", p50);
    return { etaSec, freeMode: freeEta > 3 * 3600 ? "paused" : freeEta > 30 * 60 ? "queue" : "open" };
  }

  private admissionEta(lane: Lane, p50: number): number {
    return Math.ceil((this.queuedAhead(lane) * p50) / this.opts.globalAgents / 1000);
  }
}
