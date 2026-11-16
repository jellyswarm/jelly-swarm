import type { Redis } from "ioredis";
import type { NonceStore } from "./index";

/** A payment's validity window is always far shorter than this; it only bounds storage growth. */
const NONCE_TTL_SECONDS = 7 * 24 * 3600;

/** Redis-backed nonce store. `SET ... NX` makes the claim atomic across concurrent requests. */
export class RedisNonceStore implements NonceStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "x402n:",
  ) {}

  async claim(network: string, payer: string, nonce: string): Promise<boolean> {
    const key = `${this.prefix}${network}:${payer.toLowerCase()}:${nonce.toLowerCase()}`;
    const result = await this.redis.set(key, "1", "EX", NONCE_TTL_SECONDS, "NX");
    return result === "OK";
  }
}
