import { AUDIT_ALWAYS_AT_USD6, AUDIT_SAMPLE_BPS } from "@jelly/shared";
import { type Hex, keccak256, toBytes } from "viem";

/**
 * §3.3 step 8: "settlement-keeper opens a Muster CheckerNet Audit round,
 * panel of 3, for 5% of jobs plus every job ≥ $50." The sample is
 * deterministic from the job key, not from a live random source, so the
 * decision is the same wherever and whenever it is computed, and anyone can
 * recompute it to check the keeper audited the jobs it should have.
 */
export function needsAudit(jobKey: Hex, grossUsd6: bigint, sampleBps: number = AUDIT_SAMPLE_BPS, alwaysAtUsd6: bigint = AUDIT_ALWAYS_AT_USD6): boolean {
  if (grossUsd6 >= alwaysAtUsd6) return true;
  const draw = BigInt(keccak256(toBytes(jobKey))) % 10_000n;
  return draw < BigInt(sampleBps);
}

/**
 * Which rows of a settled job to send to the panel: every failed row (the
 * ones the client would most want checked) plus up to `maxRows` of the
 * passed ones, in row order so the sample is reproducible.
 */
export function sampleRows(rowStates: readonly ("passed" | "refunded")[], maxRows = 25): number[] {
  const passed: number[] = [];
  const refunded: number[] = [];
  rowStates.forEach((s, i) => (s === "passed" ? passed : refunded).push(i));
  return [...refunded, ...passed].slice(0, maxRows).sort((a, b) => a - b);
}
