import type { Redis } from "ioredis";
import type { PowChallenge, PowStore } from "./pow";

/** Redis-backed PoW challenge store. `take` uses GETDEL so a challenge is claimed exactly once, even under concurrent redemption attempts. */
export class RedisPowStore implements PowStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "pow:",
  ) {}

  async put(c: PowChallenge): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil((c.expiresAtMs - Date.now()) / 1000));
    await this.redis.set(`${this.prefix}${c.challenge}`, JSON.stringify(c), "EX", ttlSec);
  }

  async take(challenge: string): Promise<PowChallenge | undefined> {
    const raw = await this.redis.getdel(`${this.prefix}${challenge}`);
    return raw ? (JSON.parse(raw) as PowChallenge) : undefined;
  }
}
