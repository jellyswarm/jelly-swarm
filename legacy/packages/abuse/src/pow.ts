import { createHash, randomBytes } from "node:crypto";
import { FREE_TIER } from "@jelly/shared";

/**
 * §10.3 hashcash PoW: `sha256(challenge ‖ nonce)` with `N` leading zero
 * bits. Single-use, device-bound, expires after 2 minutes. Difficulty rises
 * with IP-prefix reputation and free-queue depth; the base is calibrated to
 * take about 1-2 seconds on a phone, which `BASE_DIFFICULTY_BITS` names as a
 * starting point to tune against real client hardware.
 */
export const BASE_DIFFICULTY_BITS = 18;
export const MAX_DIFFICULTY_BITS = 28;

export type PowChallenge = { challenge: string; deviceId: string; difficultyBits: number; expiresAtMs: number };

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let b = byte;
    for (let i = 7; i >= 0; i--) {
      if ((b >> i) & 1) return bits;
      bits++;
    }
  }
  return bits;
}

export function hashOf(challenge: string, nonce: string): Buffer {
  return createHash("sha256").update(`${challenge}${nonce}`).digest();
}

/** True if `sha256(challenge ‖ nonce)` has at least `difficultyBits` leading zero bits. */
export function solves(challenge: string, nonce: string, difficultyBits: number): boolean {
  return leadingZeroBits(hashOf(challenge, nonce)) >= difficultyBits;
}

export interface PowStore {
  /** True the first time a challenge is claimed (issued); never issues the same value twice. */
  put(c: PowChallenge): Promise<void>;
  /** Removes and returns the challenge if it is still pending (single-use). */
  take(challenge: string): Promise<PowChallenge | undefined>;
}

export class MemoryPowStore implements PowStore {
  private readonly pending = new Map<string, PowChallenge>();

  async put(c: PowChallenge): Promise<void> {
    this.pending.set(c.challenge, c);
  }

  async take(challenge: string): Promise<PowChallenge | undefined> {
    const c = this.pending.get(challenge);
    if (c) this.pending.delete(challenge);
    return c;
  }
}

export type IssuePowOptions = {
  deviceId: string;
  /** Extra bits from abuse feedback or queue depth, added on top of the base difficulty. */
  penaltyBits?: number;
  now: number;
  ttlMs?: number;
};

export class ProofOfWork {
  constructor(private readonly store: PowStore) {}

  async issue(opts: IssuePowOptions): Promise<PowChallenge> {
    const difficultyBits = Math.min(MAX_DIFFICULTY_BITS, BASE_DIFFICULTY_BITS + (opts.penaltyBits ?? 0));
    const c: PowChallenge = {
      challenge: randomBytes(16).toString("base64url"),
      deviceId: opts.deviceId,
      difficultyBits,
      expiresAtMs: opts.now + (opts.ttlMs ?? FREE_TIER.powChallengeTtlMs),
    };
    await this.store.put(c);
    return c;
  }

  /** Verifies and consumes a challenge in one step: it can never be checked against twice. */
  async verify(challenge: string, nonce: string, deviceId: string, nowMs: number): Promise<boolean> {
    const c = await this.store.take(challenge);
    if (!c) return false;
    if (c.deviceId !== deviceId) return false;
    if (nowMs >= c.expiresAtMs) return false;
    return solves(challenge, nonce, c.difficultyBits);
  }
}
