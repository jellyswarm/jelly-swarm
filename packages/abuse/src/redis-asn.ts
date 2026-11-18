import type { Redis } from "ioredis";
import type { AsnLookup } from "./asn";

/** An address's ASN assignment essentially never changes minute to minute, so caching this hard is safe. */
const CACHE_TTL_SECONDS = 24 * 3600;

/** Caches `inner`'s answer per address — one external lookup per IP per day, not one per request. */
export class RedisCachedAsnLookup implements AsnLookup {
  constructor(
    private readonly inner: AsnLookup,
    private readonly redis: Redis,
    private readonly prefix = "asn:",
  ) {}

  async lookup(ip: string): Promise<number | undefined> {
    const key = `${this.prefix}${ip}`;
    const cached = await this.redis.get(key);
    if (cached !== null) return cached === "" ? undefined : Number(cached);
    const asn = await this.inner.lookup(ip);
    await this.redis.set(key, asn === undefined ? "" : String(asn), "EX", CACHE_TTL_SECONDS);
    return asn;
  }
}
