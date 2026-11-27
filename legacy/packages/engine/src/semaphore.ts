import type { Redis } from "ioredis";

/**
 * Counting semaphore with expiring holders. The scheduler already limits each
 * job to its wave width; this is the second, shared lock that holds the
 * 247-per-job cap (§3.3) even when several scheduler processes run.
 */
export interface Semaphore {
  /** Takes a slot if fewer than `limit` are held. A holder that never releases expires at `expiresAtMs`. */
  acquire(key: string, holder: string, limit: number, nowMs: number, expiresAtMs: number): Promise<boolean>;
  release(key: string, holder: string): Promise<void>;
  count(key: string, nowMs: number): Promise<number>;
}

export class MemorySemaphore implements Semaphore {
  private readonly held = new Map<string, Map<string, number>>();

  private live(key: string, nowMs: number): Map<string, number> {
    let holders = this.held.get(key);
    if (!holders) {
      holders = new Map();
      this.held.set(key, holders);
    }
    for (const [h, exp] of holders) if (exp <= nowMs) holders.delete(h);
    return holders;
  }

  async acquire(key: string, holder: string, limit: number, nowMs: number, expiresAtMs: number): Promise<boolean> {
    const holders = this.live(key, nowMs);
    if (holders.has(holder)) return true;
    if (holders.size >= limit) return false;
    holders.set(holder, expiresAtMs);
    return true;
  }

  async release(key: string, holder: string): Promise<void> {
    this.held.get(key)?.delete(holder);
  }

  async count(key: string, nowMs: number): Promise<number> {
    return this.live(key, nowMs).size;
  }
}

/** ARGV: holder, limit, now, expiresAt. KEYS[1]: zset of holders scored by expiry. */
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[4] + 60000)
return 1
`;

export class RedisSemaphore implements Semaphore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "sem:",
  ) {}

  async acquire(key: string, holder: string, limit: number, nowMs: number, expiresAtMs: number): Promise<boolean> {
    const ok = await this.redis.eval(ACQUIRE, 1, this.prefix + key, holder, String(limit), String(nowMs), String(expiresAtMs));
    return ok === 1;
  }

  async release(key: string, holder: string): Promise<void> {
    await this.redis.zrem(this.prefix + key, holder);
  }

  async count(key: string, nowMs: number): Promise<number> {
    return this.redis.zcount(this.prefix + key, `(${nowMs}`, "+inf");
  }
}
