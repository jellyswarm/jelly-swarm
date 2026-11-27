import { describe, expect, test } from "bun:test";
import type { Verdict } from "@jelly/checker";
import { MemoryEscrow, MemoryJobStore, type StoredJob } from "@jelly/service";
import type { JobSpec, PriceLines, RowResult } from "@jelly/engine";
import { usd6 } from "@jelly/shared";
import { keccak256, toBytes } from "viem";
import { MemoryFundingGraph } from "./funding-graph";
import { type KeeperEvent, SettlementKeeper, VolumeClassifier } from "./keeper";

const PAYER = "0x000000000000000000000000000000000000dEaD";
const STUDIO = new Set(["0xstudio"]);

/**
 * Drives a MemoryEscrow straight to "settled" for one job, without running
 * the engine or checker: everything the keeper looks at is set directly.
 */
async function settledFixture(
  escrow: MemoryEscrow,
  store: MemoryJobStore,
  opts: { rows: number; passed: number; grossUsd6: bigint; now: number; payer?: string },
) {
  const { jobId, jobKey } = await escrow.openJob({
    rows: opts.rows,
    unitUsd6: 1_000_000n,
    baseUsd6: 0n,
    toolsCapUsd6: 0n,
    workerOperatorId: 1n,
    expiresAtSec: Math.floor(opts.now / 1000) + 7200,
  });
  escrow.markFunded(jobId, (opts.payer ?? PAYER) as `0x${string}`);
  const seal = { root: keccak256(toBytes(`root-${jobKey}`)), count: opts.rows, head: keccak256(toBytes(`head-${jobKey}`)) };
  await escrow.seal(jobKey, seal);
  const verdict: Verdict = {
    jobKey,
    rowCount: opts.rows,
    passedCount: opts.passed,
    rowsRoot: keccak256(toBytes(`rows-${jobKey}`)),
    receiptsRoot: seal.root,
    toolsUsd6: 0n,
  };
  const settled = await escrow.settle(jobId, verdict, "0x00");

  const rows: RowResult[] = Array.from({ length: opts.rows }, (_, i) => ({
    rowIdx: i,
    state: i < opts.passed ? "passed" : "refunded",
    attempts: 1,
    hostIds: [],
    costMicros: 0n,
    toolsUsd6: 0n,
  }));
  const job: StoredJob = {
    jobKey,
    jobId,
    quoteId: "q",
    accountId: "a",
    accountTier: "paid",
    chain: "base",
    state: "settled",
    route: "wallet",
    lane: "paid",
    payer: opts.payer ?? PAYER,
    spec: { product: "fanout" } as JobSpec,
    lines: {} as PriceLines,
    walletJob: false,
    createdAtMs: opts.now,
    expiresAtSec: Math.floor(opts.now / 1000) + 7200,
    rows,
    settledAtMs: opts.now,
    releaseAtSec: settled.releaseAtSec,
    amounts: { grossUsd6: opts.grossUsd6, toolsBilledUsd6: 0n, refundUsd6: 0n },
  };
  await store.putJob(job);
  return { jobId, jobKey, releaseAtSec: settled.releaseAtSec };
}

function setup(nowMs = 1_800_000_000_000) {
  const clock = { now: nowMs };
  const now = () => clock.now;
  const escrow = new MemoryEscrow(now);
  const store = new MemoryJobStore(now);
  const classify = { studioWallets: STUDIO, graph: new MemoryFundingGraph() };
  const events: KeeperEvent[] = [];
  const keeper = new SettlementKeeper({ store, escrow, classify, now, onEvent: (e) => events.push(e) });
  return { clock, now, escrow, store, classify, keeper, events };
}

describe("SettlementKeeper.tick (§3.3 steps 8-9)", () => {
  test("a small job skips the audit and finalizes once its window has passed", async () => {
    const s = setup();
    const { jobId, jobKey } = await settledFixture(s.escrow, s.store, { rows: 3, passed: 3, grossUsd6: usd6("3"), now: s.clock.now });

    await s.keeper.tick();
    expect((await s.store.getJob(jobKey))!.auditDecision).toBe("skipped");
    expect(await s.escrow.status(jobId)).toBe("settled"); // window has not passed yet

    s.clock.now += 24 * 3600 * 1000 + 1;
    await s.keeper.tick();
    const job = (await s.store.getJob(jobKey))!;
    expect(job.state).toBe("finalized");
    expect(job.finalizeTx).toBeTruthy();
    expect(await s.escrow.status(jobId)).toBe("finalized");
    expect(s.events.map((e) => e.type)).toEqual(["audit_skipped", "finalized"]);
  });

  test("a job of $50 or more is always audited, and finalize waits for the round to close", async () => {
    const s = setup();
    const { jobKey } = await settledFixture(s.escrow, s.store, { rows: 10, passed: 10, grossUsd6: usd6("60"), now: s.clock.now });

    await s.keeper.tick();
    const afterAudit = (await s.store.getJob(jobKey))!;
    expect(afterAudit.auditDecision).toBe("audited");
    expect(afterAudit.auditRoundId).toBeDefined();

    s.clock.now += 24 * 3600 * 1000 + 1;
    await s.keeper.tick(); // window is closed, but the round is still open
    expect((await s.store.getJob(jobKey))!.state).toBe("settled");

    s.escrow.resolveRound(afterAudit.auditRoundId!);
    await s.keeper.tick();
    expect((await s.store.getJob(jobKey))!.state).toBe("finalized");
  });

  test("the audit decision is made once; a second tick before the window closes does not re-decide or re-open a round", async () => {
    const s = setup();
    const { jobKey } = await settledFixture(s.escrow, s.store, { rows: 10, passed: 10, grossUsd6: usd6("60"), now: s.clock.now });
    await s.keeper.tick();
    const first = (await s.store.getJob(jobKey))!.auditRoundId;
    await s.keeper.tick();
    const second = (await s.store.getJob(jobKey))!.auditRoundId;
    expect(second).toBe(first);
    expect(await s.escrow.roundsOpen((await s.store.getJob(jobKey))!.jobId)).toBe(1); // not two rounds
  });

  test("a failed openAuditRound or finalize call is reported, not thrown past tick()", async () => {
    const s = setup();
    await settledFixture(s.escrow, s.store, { rows: 10, passed: 10, grossUsd6: usd6("60"), now: s.clock.now });
    s.escrow.openAuditRound = async () => {
      throw new Error("rpc down");
    };
    await s.keeper.tick(); // does not throw
    expect(s.events.some((e) => (e as { type: string }).type === "keeper_error")).toBe(true);
  });

  test("tick is safe to call again on a job that is already finalized", async () => {
    const s = setup();
    const { jobKey } = await settledFixture(s.escrow, s.store, { rows: 3, passed: 3, grossUsd6: usd6("3"), now: s.clock.now });
    s.clock.now += 24 * 3600 * 1000 + 1;
    await s.keeper.tick();
    await s.keeper.tick();
    expect((await s.store.getJob(jobKey))!.state).toBe("finalized");
  });
});

describe("VolumeClassifier.classifyWindow (§8)", () => {
  test("classifies finished jobs in the window and marks them recorded, once", async () => {
    const s = setup();
    const { jobKey } = await settledFixture(s.escrow, s.store, { rows: 3, passed: 3, grossUsd6: usd6("3"), now: s.clock.now });
    s.clock.now += 24 * 3600 * 1000 + 1;
    await s.keeper.tick(); // -> finalized

    const classifier = new VolumeClassifier({ store: s.store, classify: s.classify, now: s.now });
    await classifier.classifyWindow(s.clock.now - 7 * 24 * 3600 * 1000, s.clock.now);
    const job = (await s.store.getJob(jobKey))!;
    expect(job.meterBucket).toBe("real");
    expect(job.volumeRecordedAtMs).toBeDefined();

    // Calling it again does not re-scan an already-recorded job (listForVolume excludes it).
    const before = job.volumeRecordedAtMs;
    await classifier.classifyWindow(s.clock.now - 7 * 24 * 3600 * 1000, s.clock.now);
    expect((await s.store.getJob(jobKey))!.volumeRecordedAtMs).toBe(before);
  });

  test("jobs outside the window are left unclassified", async () => {
    const s = setup();
    const { jobKey } = await settledFixture(s.escrow, s.store, { rows: 3, passed: 3, grossUsd6: usd6("3"), now: s.clock.now });
    s.clock.now += 24 * 3600 * 1000 + 1;
    await s.keeper.tick();

    const classifier = new VolumeClassifier({ store: s.store, classify: s.classify, now: s.now });
    await classifier.classifyWindow(s.clock.now + 1000, s.clock.now + 2000);
    expect((await s.store.getJob(jobKey))!.meterBucket).toBeUndefined();
  });
});
