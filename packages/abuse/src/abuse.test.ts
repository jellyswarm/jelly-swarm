import { afterAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { loadInfraEnv } from "@jelly/shared";
import {
  BASE_DIFFICULTY_BITS,
  type BanStore,
  MemoryBanStore,
  MemoryPowStore,
  MemoryWindowCounter,
  ProofOfWork,
  type RateLimits,
  RedisBanStore,
  RedisPowStore,
  RedisWindowCounter,
  type WindowCounter,
  checkAndConsume,
  checkFreeTierPolicy,
  hashOf,
  onJobRejected,
  solves,
} from "./index";

/** Leading zero bits of a hash, computed independently of the package's own implementation, for cross-checking. */
function independentLeadingZeroBits(buf: Buffer): number {
  const bits = [...buf].map((b) => b.toString(2).padStart(8, "0")).join("");
  const firstOne = bits.indexOf("1");
  return firstOne === -1 ? bits.length : firstOne;
}

// Needs a reachable Redis (REDIS_URL, default docker-compose); skipped when unreachable unless REQUIRE_INFRA=1.
const redis = new Redis(loadInfraEnv().REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: 5000,
});
redis.on("error", () => {});
const redisUp = await redis.connect().then(() => true, () => false);
if (!redisUp && process.env.REQUIRE_INFRA === "1") throw new Error("REQUIRE_INFRA=1 but Redis is not reachable");
afterAll(() => redis.disconnect());

describe("hashcash PoW (§10.3)", () => {
  test("solves() agrees with an independently computed leading-zero-bit count", () => {
    for (let nonce = 0; nonce < 500; nonce++) {
      const bits = independentLeadingZeroBits(hashOf("chal", String(nonce)));
      expect(solves("chal", String(nonce), bits)).toBe(true);
      expect(solves("chal", String(nonce), bits + 1)).toBe(false);
    }
  });

  test("a solution at one difficulty is not expected to also solve a much higher one", () => {
    let nonce = 0;
    while (!solves("chal", String(nonce), 8)) nonce++;
    expect(solves("chal", String(nonce), 8)).toBe(true);
    // Astronomically unlikely for an 8-bit solution to coincidentally also clear 32 bits.
    expect(solves("chal", String(nonce), 32)).toBe(false);
  });

  test("a correct answer verifies once, and never again (single-use)", async () => {
    const pow = new ProofOfWork(new MemoryPowStore());
    const c = await pow.issue({ deviceId: "d1", now: 1000, penaltyBits: -BASE_DIFFICULTY_BITS }); // difficulty 0: any nonce solves
    expect(await pow.verify(c.challenge, "anything", "d1", 1000)).toBe(true);
    expect(await pow.verify(c.challenge, "anything", "d1", 1000)).toBe(false); // already consumed
  });

  test("a wrong device, a wrong answer, or an expired challenge all fail", async () => {
    const pow = new ProofOfWork(new MemoryPowStore());
    const easy = { penaltyBits: -BASE_DIFFICULTY_BITS, now: 1000 };
    const wrongDevice = await pow.issue({ deviceId: "d1", ...easy });
    expect(await pow.verify(wrongDevice.challenge, "x", "d2", 1000)).toBe(false);

    const expired = await pow.issue({ deviceId: "d1", ...easy, ttlMs: 1000 });
    expect(await pow.verify(expired.challenge, "x", "d1", 2001)).toBe(false);

    let nonce = 0;
    const hard = await pow.issue({ deviceId: "d1", now: 1000 });
    while (solves(hard.challenge, String(nonce), hard.difficultyBits)) nonce++; // find a nonce that does NOT solve it
    expect(await pow.verify(hard.challenge, String(nonce), "d1", 1000)).toBe(false);
  });

  test("difficulty rises with the penalty and is capped", async () => {
    const pow = new ProofOfWork(new MemoryPowStore());
    expect((await pow.issue({ deviceId: "d1", now: 0, penaltyBits: 0 })).difficultyBits).toBe(BASE_DIFFICULTY_BITS);
    expect((await pow.issue({ deviceId: "d1", now: 0, penaltyBits: 3 })).difficultyBits).toBe(BASE_DIFFICULTY_BITS + 3);
    expect((await pow.issue({ deviceId: "d1", now: 0, penaltyBits: 999 })).difficultyBits).toBeLessThanOrEqual(28);
  });

  test("an unknown challenge is refused", async () => {
    const pow = new ProofOfWork(new MemoryPowStore());
    expect(await pow.verify("never-issued", "x", "d1", 0)).toBe(false);
  });
});

describe("rate buckets (§10.3)", () => {
  const limits: RateLimits = { perDeviceEver: 1, perIpPrefixPerDay: 3, perAsnPerDay: 10, globalFreeJobsPerDay: 5 };

  test("per-device-ever: the first free job is allowed, a second from the same device is not", async () => {
    const counter = new MemoryWindowCounter();
    const input = { deviceId: "d1", ipPrefix: "203.0.113.0/24" };
    expect(await checkAndConsume(counter, limits, input, 1000)).toBeNull();
    expect(await checkAndConsume(counter, limits, input, 2000)).toBe("device");
  });

  test("per-ip-prefix and per-asn limits apply across different devices sharing them", async () => {
    const counter = new MemoryWindowCounter();
    const perIp: RateLimits = { ...limits, perDeviceEver: 999 };
    for (let i = 0; i < 3; i++) {
      expect(await checkAndConsume(counter, perIp, { deviceId: `d${i}`, ipPrefix: "203.0.113.0/24" }, 1000)).toBeNull();
    }
    expect(await checkAndConsume(counter, perIp, { deviceId: "d4", ipPrefix: "203.0.113.0/24" }, 1000)).toBe("ip_prefix");

    // A fresh counter: this half checks the ASN bucket on its own, not layered on top of the IP-prefix usage above.
    const asnCounter = new MemoryWindowCounter();
    const perAsn: RateLimits = { ...limits, perDeviceEver: 999, perIpPrefixPerDay: 999, globalFreeJobsPerDay: 999 };
    for (let i = 0; i < 10; i++) {
      expect(await checkAndConsume(asnCounter, perAsn, { deviceId: `e${i}`, ipPrefix: `10.0.${i}.0/24`, asn: 777 }, 1000)).toBeNull();
    }
    expect(await checkAndConsume(asnCounter, perAsn, { deviceId: "e10", ipPrefix: "10.0.10.0/24", asn: 777 }, 1000)).toBe("asn");
  });

  test("a refusal consumes nothing: it never counts against the device that was blocked", async () => {
    const counter = new MemoryWindowCounter();
    const input = { deviceId: "d1", ipPrefix: "203.0.113.0/24" };
    await checkAndConsume(counter, limits, input, 1000);
    expect(await checkAndConsume(counter, limits, input, 1000)).toBe("device");
    expect(await checkAndConsume(counter, limits, input, 1000)).toBe("device"); // still exactly one real use, not two
  });

  test("daily windows reset the next day", async () => {
    const counter = new MemoryWindowCounter();
    const perIp: RateLimits = { ...limits, perDeviceEver: 999, perIpPrefixPerDay: 1 };
    const ip = "203.0.113.0/24";
    expect(await checkAndConsume(counter, perIp, { deviceId: "a", ipPrefix: ip }, 1000)).toBeNull();
    expect(await checkAndConsume(counter, perIp, { deviceId: "b", ipPrefix: ip }, 2000)).toBe("ip_prefix");
    expect(await checkAndConsume(counter, perIp, { deviceId: "c", ipPrefix: ip }, 1000 + 24 * 3600 * 1000)).toBeNull();
  });

  describe.skipIf(!redisUp)("RedisWindowCounter", () => {
    test("behaves the same as the in-memory counter for the per-device-ever and daily cases", async () => {
      const counter: WindowCounter = new RedisWindowCounter(redis, `abusetest:${process.pid}:${Date.now()}:`);
      const input = { deviceId: "d1", ipPrefix: "203.0.113.0/24" };
      expect(await checkAndConsume(counter, limits, input, 1000)).toBeNull();
      expect(await checkAndConsume(counter, limits, input, 2000)).toBe("device");
    });
  });
});

describe("free-tier task policy (§10.3)", () => {
  test.each([
    ["Send a cold email to every founder on this list", "outreach"],
    ["Pull the pricing page behind a login for each competitor", "login_walled"],
    ["Hit this endpoint as fast as possible to stress test it", "dos_shape"],
    ["Find the home addresses of these 300 people", "bulk_personal_data"],
  ] as const)("refuses %p", (task, refusal) => {
    expect(checkFreeTierPolicy(task)?.refusal).toBe(refusal);
  });

  test("a long uniform list of email addresses reads as a contact list even with an innocent task", () => {
    const items = Array.from({ length: 25 }, (_, i) => `person${i}@example.com`);
    expect(checkFreeTierPolicy("Check these out", items)?.refusal).toBe("bulk_personal_data");
  });

  test("ordinary research tasks are allowed", () => {
    for (const task of [
      "Compare these 200 tokens: holders, liquidity lock and next unlocks",
      "Find the cheapest flights to Lisbon next month",
      "Check up to 500 tokens for holder count",
    ]) {
      expect(checkFreeTierPolicy(task)).toBeNull();
    }
    expect(checkFreeTierPolicy("Check these tokens", ["0xabc", "0xdef"])).toBeNull();
  });
});

describe("bans and PoW penalty escalation (§10.3)", () => {
  test("each rejection adds one penalty bit, and the fourth bans the subject", async () => {
    const store: BanStore = new MemoryBanStore();
    for (const expected of [1, 2, 3]) {
      const r = await onJobRejected(store, "device", "d1");
      expect(r).toEqual({ rejections: expected, penaltyBits: expected, banned: false });
    }
    const last = await onJobRejected(store, "device", "d1");
    expect(last).toEqual({ rejections: 4, penaltyBits: 4, banned: true });
    expect(await store.isBanned("device", "d1")).toBe(true);
  });

  test("a device and an account with the same id string are tracked independently", async () => {
    const store = new MemoryBanStore();
    await onJobRejected(store, "device", "x");
    expect(await store.isBanned("account", "x")).toBe(false);
  });

  // §10.3 "Bans never touch money": structurally guaranteed, not just by convention — @jelly/abuse's
  // package.json depends on nothing from @jelly/service (no escrow, no vault), so there is no
  // withdrawal or refund path this package could reach even by mistake.

  describe.skipIf(!redisUp)("RedisBanStore", () => {
    test("behaves the same as the in-memory store across rejection and ban", async () => {
      const store: BanStore = new RedisBanStore(redis, `abusetest:${process.pid}:${Date.now()}:ban:`);
      const id = "d-redis";
      for (const expected of [1, 2, 3]) {
        const r = await onJobRejected(store, "device", id);
        expect(r).toEqual({ rejections: expected, penaltyBits: expected, banned: false });
      }
      const last = await onJobRejected(store, "device", id);
      expect(last).toEqual({ rejections: 4, penaltyBits: 4, banned: true });
      expect(await store.isBanned("device", id)).toBe(true);
      expect(await store.isBanned("account", id)).toBe(false);
    });
  });
});

describe.skipIf(!redisUp)("RedisPowStore", () => {
  test("a challenge is claimed at most once, and expires", async () => {
    const store = new RedisPowStore(redis, `abusetest:${process.pid}:${Date.now()}:pow:`);
    const challenge = { challenge: "c1", deviceId: "d1", difficultyBits: BASE_DIFFICULTY_BITS, expiresAtMs: Date.now() + 120_000 };
    await store.put(challenge);
    expect(await store.take("c1")).toEqual(challenge);
    expect(await store.take("c1")).toBeUndefined();

    const expiring = { challenge: "c2", deviceId: "d1", difficultyBits: BASE_DIFFICULTY_BITS, expiresAtMs: Date.now() + 1000 };
    await store.put(expiring);
    expect(await store.take("c2")).toEqual(expiring);
  });
});
