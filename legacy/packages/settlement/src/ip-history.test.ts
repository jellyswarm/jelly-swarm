import { afterAll, describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { Redis } from "ioredis";
import { MemoryIpHistory, RedisIpHistory } from "./ip-history";

describe("MemoryIpHistory", () => {
  test("a noted (account, prefix) pair is seen until the window expires", async () => {
    const store = new MemoryIpHistory(1000);
    const t0 = 1_000_000;
    await store.note("acct-1", "203.0.113.0/24", t0);
    expect(await store.seenPrefix("acct-1", "203.0.113.0/24", t0 + 500)).toBe(true);
    expect(await store.seenPrefix("acct-1", "203.0.113.0/24", t0 + 1001)).toBe(false);
  });

  test("a different account or a different prefix is never seen", async () => {
    const store = new MemoryIpHistory();
    const t0 = 1_000_000;
    await store.note("acct-1", "203.0.113.0/24", t0);
    expect(await store.seenPrefix("acct-2", "203.0.113.0/24", t0)).toBe(false);
    expect(await store.seenPrefix("acct-1", "203.0.114.0/24", t0)).toBe(false);
  });
});

// Needs a reachable Redis (REDIS_URL, default docker-compose); skipped when unreachable unless REQUIRE_INFRA=1.
const redis = new Redis(loadInfraEnv().REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: 5000,
});
redis.on("error", () => {});
const redisUp = await redis.connect().then(
  () => true,
  () => false,
);
if (!redisUp && process.env.REQUIRE_INFRA === "1") throw new Error("REQUIRE_INFRA=1 but Redis is not reachable");
afterAll(() => redis.disconnect());

describe("RedisIpHistory", () => {
  test.skipIf(!redisUp)("behaves the same as the in-memory store: seen only for the noted account and prefix", async () => {
    const store = new RedisIpHistory(redis, 60, `iptest:${process.pid}:${Date.now()}:`);
    const now = Date.now();
    await store.note("acct-1", "203.0.113.0/24", now);
    expect(await store.seenPrefix("acct-1", "203.0.113.0/24", now)).toBe(true);
    expect(await store.seenPrefix("acct-2", "203.0.113.0/24", now)).toBe(false);
    expect(await store.seenPrefix("acct-1", "203.0.114.0/24", now)).toBe(false);
  });
});
