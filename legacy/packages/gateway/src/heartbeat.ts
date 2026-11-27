import { HEARTBEAT_BPS } from "@jelly/shared";

/**
 * §2.3 heartbeat downgrade, driven by how much of the job's quote is left.
 *
 *   >= 50%   normal
 *   20-50%   downgrade: drop one model class and halve the wave width
 *   < 20%    finish: no new rows; finish and check what is in flight
 *   0        stop: unfinished rows refund
 */
export type HeartbeatLevel = "normal" | "downgrade" | "finish" | "stop";

export type Heartbeat = {
  level: HeartbeatLevel;
  remainingMicros: bigint;
  /** Multiply the wave width by this. */
  waveWidthFactor: 1 | 0.5 | 0;
  /** Whether the scheduler may start rows that have not begun. */
  mayStartRows: boolean;
};

export function heartbeatFor(quoteMicros: bigint, spentMicros: bigint): Heartbeat {
  const remaining = spentMicros >= quoteMicros ? 0n : quoteMicros - spentMicros;
  if (remaining === 0n) {
    return { level: "stop", remainingMicros: 0n, waveWidthFactor: 0, mayStartRows: false };
  }
  const bps = (remaining * 10_000n) / quoteMicros;
  if (bps >= BigInt(HEARTBEAT_BPS.normal)) {
    return { level: "normal", remainingMicros: remaining, waveWidthFactor: 1, mayStartRows: true };
  }
  if (bps >= BigInt(HEARTBEAT_BPS.downgrade)) {
    return { level: "downgrade", remainingMicros: remaining, waveWidthFactor: 0.5, mayStartRows: true };
  }
  return { level: "finish", remainingMicros: remaining, waveWidthFactor: 0, mayStartRows: false };
}
