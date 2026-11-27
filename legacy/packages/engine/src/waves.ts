import {
  EXPIRY_BASE_MS,
  EXPIRY_MAX_MS,
  EXPIRY_PER_EXTRA_WAVE_MS,
  JOB_WALL_BASE_MS,
  JOB_WALL_MAX_MS,
  JOB_WALL_PER_EXTRA_WAVE_MS,
  MAX_AGENTS,
} from "@jelly/shared";

export type Wave = { wave: number; from: number; to: number };

/**
 * Splits `pieces` rows into waves of at most 247 (§3.2). Wave size is always
 * the full cap, whatever the job's own concurrency: 600 items are 3 waves.
 */
export function planWaves(pieces: number): Wave[] {
  if (!Number.isInteger(pieces) || pieces < 1) throw new Error(`invalid piece count: ${pieces}`);
  const waves: Wave[] = [];
  for (let from = 0; from < pieces; from += MAX_AGENTS) {
    waves.push({ wave: waves.length, from, to: Math.min(pieces, from + MAX_AGENTS) - 1 });
  }
  return waves;
}

/** §3.3 Escrow expiry: 2h + 1h per extra wave, at most 24h. After it, anyone may claim a full refund. */
export const expiryMs = (waves: number): number =>
  Math.min(EXPIRY_MAX_MS, EXPIRY_BASE_MS + Math.max(0, waves - 1) * EXPIRY_PER_EXTRA_WAVE_MS);

/** §13 Job wall clock: 30 min + 15 min per extra wave, hard 24h. Always inside the escrow expiry. */
export const jobWallClockMs = (waves: number): number =>
  Math.min(JOB_WALL_MAX_MS, JOB_WALL_BASE_MS + Math.max(0, waves - 1) * JOB_WALL_PER_EXTRA_WAVE_MS);
