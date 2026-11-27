import type { Redis } from "ioredis";
import type { WindowCounter } from "./buckets";

/**
 * Redis-backed window counter: one key per (bucket, window-start), `INCR` +
 * `EXPIRE`. Simpler than `@jelly/budget-guard`'s Lua scripts because a rate
 * bucket only ever goes up by one at a time and never needs to be rolled
 * back, so there is no atomic-reserve-then-settle step to get right.
 */
export class RedisWindowCounter implements WindowCounter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "rate:",
  ) {}

  private key(key: string, windowMs: number, nowMs: number): string {
    const windowStart = windowMs === Number.MAX_SAFE_INTEGER ? 0 : Math.floor(nowMs / windowMs) * windowMs;
    return `${this.prefix}${key}:${windowStart}`;
  }

  async increment(key: string, windowMs: number, nowMs: number): Promise<number> {
    const redisKey = this.key(key, windowMs, nowMs);
    const count = await this.redis.incr(redisKey);
    if (count === 1 && windowMs !== Number.MAX_SAFE_INTEGER) {
      await this.redis.expire(redisKey, Math.ceil(windowMs / 1000) + 60);
    }
    return count;
  }

  async peek(key: string, windowMs: number, nowMs: number): Promise<number> {
    const value = await this.redis.get(this.key(key, windowMs, nowMs));
    return value ? Number(value) : 0;
  }
}
