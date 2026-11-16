import type { Redis } from "ioredis";
import type { BanStore, SubjectKind } from "./bans";

/**
 * Redis-backed ban store. Bans and rejection counts never expire on their
 * own (§10.3: an escalation is a standing fact, not a rate window), so these
 * keys carry no TTL — only an explicit unban (not exposed here; the build
 * doc gives no path for it) would remove one.
 */
export class RedisBanStore implements BanStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "ban:",
  ) {}

  private key(kind: SubjectKind, id: string): string {
    return `${this.prefix}${kind}:${id}`;
  }

  async isBanned(kind: SubjectKind, id: string): Promise<boolean> {
    return (await this.redis.get(`${this.key(kind, id)}:banned`)) === "1";
  }

  async ban(kind: SubjectKind, id: string): Promise<void> {
    await this.redis.set(`${this.key(kind, id)}:banned`, "1");
  }

  async recordRejection(kind: SubjectKind, id: string): Promise<number> {
    return this.redis.incr(`${this.key(kind, id)}:rejections`);
  }

  async penaltyBits(kind: SubjectKind, id: string): Promise<number> {
    const n = await this.redis.get(`${this.key(kind, id)}:rejections`);
    return n ? Number(n) : 0;
  }
}
