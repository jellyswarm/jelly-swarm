import { describe, expect, test } from "bun:test";
import { keccak256, toBytes } from "viem";
import { MemoryEscrow } from "./escrow";

const PAYER = "0x000000000000000000000000000000000000dEaD" as const;

function clock(startMs = 1_800_000_000_000) {
  const state = { now: startMs };
  return { state, now: () => state.now };
}

async function openAndSettle(escrow: MemoryEscrow, passed: number, rows = passed) {
  const { jobId, jobKey } = await escrow.openJob({
    rows,
    unitUsd6: 1_000_000n,
    baseUsd6: 0n,
    toolsCapUsd6: 0n,
    workerOperatorId: 1n,
    expiresAtSec: 999_999_999_999,
  });
  escrow.markFunded(jobId, PAYER);
  const seal = { root: keccak256(toBytes(`root-${jobKey}`)), count: rows, head: keccak256(toBytes(`head-${jobKey}`)) };
  await escrow.seal(jobKey, seal);
  const settled = await escrow.settle(
    jobId,
    { jobKey, rowCount: rows, passedCount: passed, rowsRoot: keccak256(toBytes("rows")), receiptsRoot: seal.root, toolsUsd6: 0n },
    "0x00",
  );
  return { jobId, jobKey, releaseAtSec: settled.releaseAtSec };
}

describe("MemoryEscrow: audit rounds and finalize (§3.3 steps 8-9)", () => {
  test("a round can only be opened on a settled job, before its window closes", async () => {
    const { now } = clock();
    const escrow = new MemoryEscrow(now);
    const { jobId: openId } = await escrow.openJob({ rows: 1, unitUsd6: 1n, baseUsd6: 0n, toolsCapUsd6: 0n, workerOperatorId: 1n, expiresAtSec: 999_999_999_999 });
    await expect(escrow.openAuditRound(openId, [0])).rejects.toThrow("not settled");

    const c = clock();
    const escrow2 = new MemoryEscrow(c.now);
    const { jobId, releaseAtSec } = await openAndSettle(escrow2, 3);
    c.state.now = (releaseAtSec + 1) * 1000;
    await expect(escrow2.openAuditRound(jobId, [0])).rejects.toThrow("window is closed");
  });

  test("roundsOpen tracks how many unresolved rounds a job has; resolveRound clears one", async () => {
    const c = clock();
    const escrow = new MemoryEscrow(c.now);
    const { jobId } = await openAndSettle(escrow, 5);
    expect(await escrow.roundsOpen(jobId)).toBe(0);
    const { roundId: r1 } = await escrow.openAuditRound(jobId, [0, 1]);
    const { roundId: r2 } = await escrow.openAuditRound(jobId, [2]);
    expect(await escrow.roundsOpen(jobId)).toBe(2);
    escrow.resolveRound(r1);
    expect(await escrow.roundsOpen(jobId)).toBe(1);
    escrow.resolveRound(r1); // resolving twice does not go negative
    expect(await escrow.roundsOpen(jobId)).toBe(1);
    escrow.resolveRound(r2);
    expect(await escrow.roundsOpen(jobId)).toBe(0);
  });

  test("finalize refuses before the window closes, and while a round is open", async () => {
    const c = clock();
    const escrow = new MemoryEscrow(c.now);
    const { jobId, releaseAtSec } = await openAndSettle(escrow, 5);
    await expect(escrow.finalize(jobId)).rejects.toThrow("window is still open");

    c.state.now = releaseAtSec * 1000;
    const { roundId } = await escrow.openAuditRound(jobId, [0]);
    c.state.now = (releaseAtSec + 1) * 1000;
    await expect(escrow.finalize(jobId)).rejects.toThrow("round is still open");

    escrow.resolveRound(roundId);
    const { tx } = await escrow.finalize(jobId);
    expect(tx).toBeTruthy();
    expect(await escrow.status(jobId)).toBe("finalized");
    expect(escrow.finalized.has(jobId)).toBe(true);
  });

  test("finalize is refused a second time once a job is already finalized", async () => {
    const c = clock();
    const escrow = new MemoryEscrow(c.now);
    const { jobId, releaseAtSec } = await openAndSettle(escrow, 1);
    c.state.now = (releaseAtSec + 1) * 1000;
    await escrow.finalize(jobId);
    await expect(escrow.finalize(jobId)).rejects.toThrow("not settled");
  });

  test("a job with nothing passed settles straight to refunded and is never a target for audit or finalize", async () => {
    const c = clock();
    const escrow = new MemoryEscrow(c.now);
    const { jobId } = await openAndSettle(escrow, 0, 5);
    expect(await escrow.status(jobId)).toBe("refunded");
    await expect(escrow.openAuditRound(jobId, [0])).rejects.toThrow("not settled");
    await expect(escrow.finalize(jobId)).rejects.toThrow("not settled");
  });
});
