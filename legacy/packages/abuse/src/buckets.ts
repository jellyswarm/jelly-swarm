/**
 * §10.3 rate buckets: "1 free job, ever" per device, "3 / 24h" per IP prefix,
 * "10 / 24h" per datacenter ASN, plus an admin-set global daily budget.
 * Every one of these is really a fixed-window counter ("N per window"), not
 * a leaky bucket, so that is what this implements: simpler, and exactly
 * what the doc's numbers describe.
 */
export interface WindowCounter {
  /** Increments `key`'s counter for the window containing `nowMs` and returns the new count. */
  increment(key: string, windowMs: number, nowMs: number): Promise<number>;
  /** The current count for `key`'s window, without incrementing. */
  peek(key: string, windowMs: number, nowMs: number): Promise<number>;
}

export class MemoryWindowCounter implements WindowCounter {
  private readonly counts = new Map<string, { windowStart: number; count: number }>();

  private slot(key: string, windowMs: number, nowMs: number) {
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const existing = this.counts.get(key);
    if (existing && existing.windowStart === windowStart) return existing;
    const fresh = { windowStart, count: 0 };
    this.counts.set(key, fresh);
    return fresh;
  }

  async increment(key: string, windowMs: number, nowMs: number): Promise<number> {
    const slot = this.slot(key, windowMs, nowMs);
    slot.count += 1;
    return slot.count;
  }

  async peek(key: string, windowMs: number, nowMs: number): Promise<number> {
    return this.slot(key, windowMs, nowMs).count;
  }
}

const DAY_MS = 24 * 3600 * 1000;

export type RateLimits = {
  perDeviceEver: number;
  perIpPrefixPerDay: number;
  perAsnPerDay: number;
  /** Admin-set (§10.3 "freeTierBudgetUsd/day"); checked by the caller against spend, not here. */
  globalFreeJobsPerDay?: number;
};

export type RateCheckInput = { deviceId: string; ipPrefix: string; asn?: number };
export type RateRefusal = "device" | "ip_prefix" | "asn" | "global";

/**
 * Checks every applicable bucket and, only if all have room, increments all
 * of them together. A refusal increments nothing, so a blocked attempt
 * never itself counts against a later legitimate one.
 */
export async function checkAndConsume(counter: WindowCounter, limits: RateLimits, input: RateCheckInput, nowMs: number): Promise<RateRefusal | null> {
  const deviceKey = `device:${input.deviceId}`;
  const ipKey = `ip:${input.ipPrefix}`;
  const asnKey = input.asn !== undefined ? `asn:${input.asn}` : undefined;
  const globalKey = "global";

  // "Ever" is just a window the size of forever.
  if ((await counter.peek(deviceKey, Number.MAX_SAFE_INTEGER, nowMs)) >= limits.perDeviceEver) return "device";
  if ((await counter.peek(ipKey, DAY_MS, nowMs)) >= limits.perIpPrefixPerDay) return "ip_prefix";
  if (asnKey && (await counter.peek(asnKey, DAY_MS, nowMs)) >= limits.perAsnPerDay) return "asn";
  if (limits.globalFreeJobsPerDay !== undefined && (await counter.peek(globalKey, DAY_MS, nowMs)) >= limits.globalFreeJobsPerDay) {
    return "global";
  }

  await counter.increment(deviceKey, Number.MAX_SAFE_INTEGER, nowMs);
  await counter.increment(ipKey, DAY_MS, nowMs);
  if (asnKey) await counter.increment(asnKey, DAY_MS, nowMs);
  if (limits.globalFreeJobsPerDay !== undefined) await counter.increment(globalKey, DAY_MS, nowMs);
  return null;
}
