import type { Redis } from "ioredis";

/**
 * §11.4 "shared IP prefix within 24h" self-referral signal: which IP prefixes an account has
 * been seen from, and when — the piece `computeReferralSignals`'s own comment says doesn't exist
 * yet. `note` is called for every request worth tracking (sign-up, referral-code use); `seenPrefix`
 * checks the referrer's history against the referee's current prefix.
 */
export interface IpHistory {
  note(accountId: string, ipPrefix: string, nowMs: number): Promise<void>;
  seenPrefix(accountId: string, ipPrefix: string, nowMs: number): Promise<boolean>;
}

export class MemoryIpHistory implements IpHistory {
  private readonly expiresAtMs = new Map<string, number>();

  constructor(private readonly windowMs = 24 * 3600 * 1000) {}

  private key(accountId: string, ipPrefix: string): string {
    return `${accountId}\u0000${ipPrefix}`;
  }

  async note(accountId: string, ipPrefix: string, nowMs: number): Promise<void> {
    this.expiresAtMs.set(this.key(accountId, ipPrefix), nowMs + this.windowMs);
  }

  async seenPrefix(accountId: string, ipPrefix: string, nowMs: number): Promise<boolean> {
    const expires = this.expiresAtMs.get(this.key(accountId, ipPrefix));
    return expires !== undefined && nowMs < expires;
  }
}

/** Redis-backed: a TTL'd key per (account, prefix) pair is both the storage and the lookback window. */
export class RedisIpHistory implements IpHistory {
  constructor(
    private readonly redis: Redis,
    private readonly windowSeconds = 24 * 3600,
    private readonly prefix = "ipx:",
  ) {}

  async note(accountId: string, ipPrefix: string, _nowMs: number): Promise<void> {
    await this.redis.set(`${this.prefix}${accountId}:${ipPrefix}`, "1", "EX", this.windowSeconds);
  }

  async seenPrefix(accountId: string, ipPrefix: string, _nowMs: number): Promise<boolean> {
    return (await this.redis.exists(`${this.prefix}${accountId}:${ipPrefix}`)) === 1;
  }
}
