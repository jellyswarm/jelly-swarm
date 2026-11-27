import type { Gateway, JobContext } from "@jelly/gateway";
import type { RoleManifest } from "@jelly/policy";
import type { ReceiptChain } from "@jelly/receipts";
import { type AccountTier, MAX_AGENTS, ROW_CAPS, type TileState } from "@jelly/shared";
import { type Dispatch, Scheduler } from "./scheduler";
import { MemorySemaphore, type Semaphore } from "./semaphore";
import type { Cells, JobSpec } from "./spec";
import { type Wave, jobWallClockMs, planWaves } from "./waves";
import { JobGuards, type RowFailure, type ToolExecutor, type WorkerOutcome, runRow } from "./worker";

/** The checker's verdict on one row. The real checker is Phase 3; the engine only needs this shape. */
export type RowVerdict = { pass: true; cells: Cells } | { pass: false; reason: string };
export type RowChecker = (job: EngineJob, rowIdx: number, cells: Cells) => Promise<RowVerdict>;

/** Runs one attempt at one row. The default runs the worker loop in this process. */
export type RowExecutor = (job: EngineJob, d: Dispatch, slot: number, excludeHosts: readonly string[]) => Promise<WorkerOutcome>;

export type EngineJob = {
  ctx: JobContext;
  spec: JobSpec;
  accountTier: AccountTier;
  /** The quoted ceiling for paid tool spend. */
  toolsCapUsd6: bigint;
};

export type RowResult = {
  rowIdx: number;
  state: "passed" | "refunded";
  cells?: Cells;
  /** 1 or 2. 0 if the row never started. */
  attempts: number;
  failReason?: RowFailure | "checker" | "not_started" | "job_timeout";
  /** Hosts that produced the passing attempt. */
  hostIds: string[];
  costMicros: bigint;
  toolsUsd6: bigint;
};

export type JobResult = {
  jobKey: string;
  rows: RowResult[];
  passed: number;
  refunded: number;
  waves: number;
  /** Raw paid-tool spend on passed rows only; spend on failed rows is ours. */
  toolsUsd6: bigint;
  /** Highest number of this job's rows that ran at once. */
  peakConcurrency: number;
};

export type EngineEvent =
  | { type: "wave.started"; jobKey: string; wave: number; rows: [number, number] }
  | { type: "tile"; jobKey: string; agentIdx: number; rowIdx: number; state: TileState };

export type EngineDeps = {
  gateway: Gateway;
  scheduler?: Scheduler;
  checker: RowChecker;
  /** Defaults to the in-process worker loop, which needs `workerManifest`, `tools` and `receipts`. */
  executor?: RowExecutor;
  workerManifest?: RoleManifest;
  tools?: ToolExecutor;
  receipts?: ReceiptChain;
  semaphore?: Semaphore;
  onEvent?: (e: EngineEvent) => void;
  now?: () => number;
};

type Running = {
  job: EngineJob;
  guards: JobGuards;
  rows: Map<number, RowResult>;
  /** Hosts used by a row's failed first attempt. */
  avoid: Map<number, string[]>;
  freeSlots: number[];
  inFlight: number;
  peak: number;
  deadline: number;
  /** Set once no new rows may start; holds the reason. */
  stopped: false | "not_started" | "job_timeout";
  resolve: (r: JobResult) => void;
  reject: (e: unknown) => void;
};

/**
 * §3.3 fan-out and check. Pulls rows from the scheduler, runs each through
 * the worker loop and the checker, retries a failed row once on a different
 * host, and reports every row as passed or refunded.
 */
export class Engine {
  readonly scheduler: Scheduler;
  private readonly semaphore: Semaphore;
  private readonly running = new Map<string, Running>();
  private readonly now: () => number;
  private readonly executor: RowExecutor;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.semaphore = deps.semaphore ?? new MemorySemaphore();
    this.scheduler =
      deps.scheduler ??
      new Scheduler(
        { globalAgents: 4 * MAX_AGENTS },
        {
          onWaveStarted: (jobKey, wave) => this.emitWave(jobKey, wave),
        },
      );
    this.executor = deps.executor ?? this.defaultExecutor();
  }

  /** For a scheduler built by the caller: forward its wave events here. */
  emitWave(jobKey: string, wave: Wave): void {
    this.deps.onEvent?.({ type: "wave.started", jobKey, wave: wave.wave, rows: [wave.from, wave.to] });
  }

  private defaultExecutor(): RowExecutor {
    return (job, d, slot, excludeHosts) => {
      const { workerManifest, tools, receipts } = this.deps;
      if (!workerManifest || !tools || !receipts) {
        throw new Error("the default row executor needs workerManifest, tools and receipts");
      }
      const guards = this.running.get(job.ctx.jobKey)!.guards;
      return runRow({
        gateway: this.deps.gateway,
        job: job.ctx,
        spec: job.spec,
        rowIdx: d.rowIdx,
        slot,
        manifest: workerManifest,
        tools,
        guards,
        receipts,
        excludeHosts,
        now: this.now,
      });
    };
  }

  /** Runs a funded job to completion. Resolves when every row is passed or refunded. */
  run(job: EngineJob): Promise<JobResult> {
    const { jobKey } = job.ctx;
    if (this.running.has(jobKey)) throw new Error(`job is already running: ${jobKey}`);
    if (job.ctx.walletJob && job.spec.tier !== "sealed") throw new Error("a wallet job must be Sealed");
    if (job.spec.tier !== job.ctx.tier || job.spec.product !== job.ctx.product) {
      throw new Error("job context does not match its spec");
    }
    const agents = Math.min(job.spec.maxAgents, job.spec.items.length, MAX_AGENTS);
    const waves = planWaves(job.spec.items.length).length;

    return new Promise<JobResult>((resolve, reject) => {
      this.running.set(jobKey, {
        job,
        guards: new JobGuards(job.toolsCapUsd6),
        rows: new Map(),
        avoid: new Map(),
        freeSlots: Array.from({ length: agents }, (_, i) => agents - i),
        inFlight: 0,
        peak: 0,
        deadline: this.now() + jobWallClockMs(waves),
        stopped: false,
        resolve,
        reject,
      });
      this.scheduler.submit({
        jobKey,
        accountId: job.ctx.accountId,
        accountTier: job.accountTier,
        lane: job.ctx.lane,
        rows: job.spec.items.length,
        maxAgents: agents,
      });
      this.pump();
    });
  }

  private pump(): void {
    for (let d = this.scheduler.next(); d; d = this.scheduler.next()) {
      const run = this.running.get(d.jobKey);
      if (!run) {
        this.scheduler.complete(d.jobKey, d.rowIdx, "final");
        continue;
      }
      this.runDispatch(run, d).catch((e) => this.abort(run, e));
    }
  }

  private async runDispatch(run: Running, d: Dispatch): Promise<void> {
    const { job } = run;
    const { jobKey } = job.ctx;
    const slot = run.freeSlots.pop();
    if (slot === undefined) throw new Error("scheduler exceeded the job's wave width");
    const holder = `${d.rowIdx}-${d.attempt}`;
    let retry = false;

    try {
      // Second, shared lock on the per-job cap. The scheduler should never let this fail.
      const held = await this.semaphore.acquire(jobKey, holder, MAX_AGENTS, this.now(), this.now() + ROW_CAPS.wallClockMs * 2);
      if (!held) throw new Error(`more than ${MAX_AGENTS} rows in flight for job ${jobKey}`);
      run.inFlight++;
      run.peak = Math.max(run.peak, run.inFlight);

      // ── may this row start at all? ──
      if (!run.stopped) {
        if (this.now() >= run.deadline) this.stop(run, "job_timeout");
        else {
          const hb = await this.deps.gateway.heartbeat(job.ctx);
          if (!hb.mayStartRows) this.stop(run, "not_started");
          else this.scheduler.setWidthFactor(jobKey, hb.waveWidthFactor);
        }
      }
      if (run.stopped) {
        this.finalize(run, d, { state: "refunded", failReason: run.stopped });
        return;
      }

      // ── work ──
      this.tile(run, slot, d.rowIdx, d.attempt === 0 ? "working" : "retrying");
      const outcome = await this.executor(job, d, slot, run.avoid.get(d.rowIdx) ?? []);
      let failReason: RowResult["failReason"] | undefined;
      let cells: Cells | undefined;

      if (outcome.ok) {
        this.tile(run, slot, d.rowIdx, "checking");
        const verdict = await this.deps.checker(job, d.rowIdx, outcome.cells);
        if (verdict.pass) cells = verdict.cells;
        else failReason = "checker";
      } else {
        failReason = outcome.reason;
      }

      if (cells) {
        this.tile(run, slot, d.rowIdx, "passed");
        this.finalize(run, d, {
          state: "passed",
          cells,
          hostIds: outcome.hostIds,
          costMicros: outcome.costMicros,
          toolsUsd6: outcome.toolsUsd6,
        });
        return;
      }

      // §3.3 step 4: one retry on a different host, then the row is dropped.
      // Running out of budget is not retried: a retry could only fail the same way.
      const retryable = d.attempt === 0 && failReason !== "budget" && failReason !== "overrun" && !run.stopped;
      if (retryable) {
        run.avoid.set(d.rowIdx, outcome.hostIds);
        retry = true;
        return;
      }
      this.tile(run, slot, d.rowIdx, "refunded");
      this.finalize(run, d, { state: "refunded", failReason: failReason ?? "checker", costMicros: outcome.costMicros });
    } finally {
      run.inFlight = Math.max(0, run.inFlight - 1);
      run.freeSlots.push(slot);
      await this.semaphore.release(jobKey, holder);
      this.scheduler.complete(jobKey, d.rowIdx, retry ? "retry" : "final");
      this.settleIfDone(run);
      this.pump();
    }
  }

  /** No new rows for this job: everything not yet started is refunded. */
  private stop(run: Running, reason: "not_started" | "job_timeout"): void {
    run.stopped = reason;
    for (const rowIdx of this.scheduler.drain(run.job.ctx.jobKey)) {
      run.rows.set(rowIdx, {
        rowIdx,
        state: "refunded",
        attempts: run.avoid.has(rowIdx) ? 1 : 0,
        failReason: reason,
        hostIds: [],
        costMicros: 0n,
        toolsUsd6: 0n,
      });
    }
  }

  private finalize(run: Running, d: Dispatch, r: Partial<RowResult> & { state: RowResult["state"] }): void {
    run.rows.set(d.rowIdx, {
      rowIdx: d.rowIdx,
      attempts: d.attempt + 1,
      hostIds: [],
      costMicros: 0n,
      toolsUsd6: 0n,
      ...r,
    });
  }

  private settleIfDone(run: Running): void {
    const { jobKey } = run.job.ctx;
    const total = run.job.spec.items.length;
    if (run.rows.size < total || run.inFlight > 0 || !this.running.has(jobKey)) return;
    this.running.delete(jobKey);
    const rows = [...run.rows.values()].sort((a, b) => a.rowIdx - b.rowIdx);
    const passed = rows.filter((r) => r.state === "passed");
    run.resolve({
      jobKey,
      rows,
      passed: passed.length,
      refunded: total - passed.length,
      waves: planWaves(total).length,
      toolsUsd6: passed.reduce((s, r) => s + r.toolsUsd6, 0n),
      peakConcurrency: run.peak,
    });
  }

  private abort(run: Running, error: unknown): void {
    const { jobKey } = run.job.ctx;
    if (!this.running.has(jobKey)) return;
    this.running.delete(jobKey);
    this.scheduler.drain(jobKey);
    run.reject(error);
  }

  private tile(run: Running, agentIdx: number, rowIdx: number, state: TileState): void {
    this.deps.onEvent?.({ type: "tile", jobKey: run.job.ctx.jobKey, agentIdx, rowIdx, state });
  }
}
