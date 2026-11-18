import { afterAll, describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { Redis } from "ioredis";
import { type AsnLookup, RedisCachedAsnLookup, RipeAsnLookup } from "./index";

describe("RipeAsnLookup", () => {
  const fakeFetch = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("reads the first ASN out of RIPEstat's network-info response", async () => {
    const lookup = new RipeAsnLookup({ fetch: fakeFetch(200, { data: { asns: ["15169"] } }) });
    expect(await lookup.lookup("8.8.8.8")).toBe(15169);
  });

  test("resolves to undefined — never throws — on a non-200, a malformed body, or a network error", async () => {
    expect(await new RipeAsnLookup({ fetch: fakeFetch(500, {}) }).lookup("1.2.3.4")).toBeUndefined();
    expect(await new RipeAsnLookup({ fetch: fakeFetch(200, { data: {} }) }).lookup("1.2.3.4")).toBeUndefined();
    expect(await new RipeAsnLookup({ fetch: fakeFetch(200, { data: { asns: [] } }) }).lookup("1.2.3.4")).toBeUndefined();
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await new RipeAsnLookup({ fetch: throwingFetch }).lookup("1.2.3.4")).toBeUndefined();
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

describe("RedisCachedAsnLookup", () => {
  test.skipIf(!redisUp)("calls through once per address, then serves the cached answer without calling again", async () => {
    let calls = 0;
    const inner: AsnLookup = {
      async lookup() {
        calls++;
        return 15169;
      },
    };
    const cached = new RedisCachedAsnLookup(inner, redis, `asntest:${process.pid}:${Date.now()}:`);
    expect(await cached.lookup("8.8.8.8")).toBe(15169);
    expect(await cached.lookup("8.8.8.8")).toBe(15169);
    expect(calls).toBe(1);
  });

  test.skipIf(!redisUp)("caches an undefined answer too, so an unresolvable address isn't retried every request", async () => {
    let calls = 0;
    const inner: AsnLookup = {
      async lookup() {
        calls++;
        return undefined;
      },
    };
    const cached = new RedisCachedAsnLookup(inner, redis, `asntest:${process.pid}:${Date.now()}:`);
    expect(await cached.lookup("10.0.0.1")).toBeUndefined();
    expect(await cached.lookup("10.0.0.1")).toBeUndefined();
    expect(calls).toBe(1);
  });

  test.skipIf(!redisUp)("different addresses are cached independently", async () => {
    const inner: AsnLookup = { async lookup(ip) { return ip === "8.8.8.8" ? 15169 : 13335; } };
    const cached = new RedisCachedAsnLookup(inner, redis, `asntest:${process.pid}:${Date.now()}:`);
    expect(await cached.lookup("8.8.8.8")).toBe(15169);
    expect(await cached.lookup("1.1.1.1")).toBe(13335);
  });
});
