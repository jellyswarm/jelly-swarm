import { afterAll, describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { Redis } from "ioredis";
import {
  type BudgetLimits,
  type BudgetStore,
  DuplicateReservationError,
  MemoryBudgetStore,
  RedisBudgetStore,
  UnknownReservationError,
  budgetKeys,
  jobBudgetKey,
  utcDay,
} from "./index";

/**
 * The same contract runs against both stores. The Redis half needs the
 * docker-compose Redis; it is skipped when unreachable unless REQUIRE_INFRA=1.
 */
const redis = new Redis(loadInfraEnv().REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: 1500,
});
redis.on("error", () => {});
const redisUp = await redis.connect().then(
  () => true,
  () => false,
);
if (!redisUp && process.env.REQUIRE_INFRA === "1") throw new Error("REQUIRE_INFRA=1 but Redis is not reachable");
afterAll(() => redis.disconnect());

let run = 0;
const stores: [string, boolean, () => BudgetStore][] = [
  ["memory", true, () => new MemoryBudgetStore()],
  ["redis", redisUp, () => new RedisBudgetStore(redis, { prefix: `bgtest:${process.pid}:${Date.now()}:${run++}:` })],
];

const FAR = Date.now() + 600_000;

for (const [name, available, make] of stores) {
  describe.skipIf(!available)(`budget store contract: ${name}`, () => {
    test("reserves against every key and settles at the actual cost", async () => {
      const s = make();
      const keys = [
        { key: "job:a", limitMicros: 1000n },
        { key: "day", limitMicros: 5000n },
      ];
      expect(await s.reserve("r1", keys, 400n, FAR)).toEqual({ ok: true });
      expect(await s.usage("job:a")).toEqual({ usedMicros: 0n, reservedMicros: 400n });
      expect(await s.settle("r1", 250n)).toEqual({ reservedMicros: 400n, actualMicros: 250n, overrunMicros: 0n });
      expect(await s.usage("job:a")).toEqual({ usedMicros: 250n, reservedMicros: 0n });
      expect(await s.usage("day")).toEqual({ usedMicros: 250n, reservedMicros: 0n });
    });

    test("refuses a call that would exceed any one budget, and debits nothing", async () => {
      const s = make();
      const keys = [
        { key: "job:a", limitMicros: 1000n },
        { key: "day", limitMicros: 300n },
      ];
      const r = await s.reserve("r1", keys, 400n, FAR);
      expect(r).toEqual({
        ok: false,
        key: "day",
        limitMicros: 300n,
        usedMicros: 0n,
        reservedMicros: 0n,
        requestedMicros: 400n,
      });
      expect(await s.usage("job:a")).toEqual({ usedMicros: 0n, reservedMicros: 0n });
    });

    test("pending reservations count against the limit", async () => {
      const s = make();
      const keys = [{ key: "job:a", limitMicros: 1000n }];
      expect((await s.reserve("r1", keys, 600n, FAR)).ok).toBe(true);
      expect((await s.reserve("r2", keys, 600n, FAR)).ok).toBe(false);
      expect((await s.reserve("r3", keys, 400n, FAR)).ok).toBe(true);
      expect((await s.reserve("r4", keys, 1n, FAR)).ok).toBe(false);
    });

    test("the limit is inclusive: spending exactly the quote is allowed", async () => {
      const s = make();
      const keys = [{ key: "job:a", limitMicros: 1000n }];
      expect((await s.reserve("r1", keys, 1000n, FAR)).ok).toBe(true);
      await s.settle("r1", 1000n);
      expect((await s.reserve("r2", keys, 1n, FAR)).ok).toBe(false);
    });

    test("247 concurrent reservations never oversubscribe the budget", async () => {
      const s = make();
      const keys = [{ key: "job:a", limitMicros: 1000n }];
      const results = await Promise.all(
        Array.from({ length: 247 }, (_, i) => s.reserve(`r${i}`, keys, 10n, FAR)),
      );
      expect(results.filter((r) => r.ok).length).toBe(100);
      expect(await s.usage("job:a")).toEqual({ usedMicros: 0n, reservedMicros: 1000n });
    });

    test("an overrun is recorded in full and blocks later calls", async () => {
      const s = make();
      const keys = [{ key: "job:a", limitMicros: 1000n }];
      await s.reserve("r1", keys, 100n, FAR);
      expect(await s.settle("r1", 1500n)).toEqual({ reservedMicros: 100n, actualMicros: 1500n, overrunMicros: 1400n });
      expect(await s.usage("job:a")).toEqual({ usedMicros: 1500n, reservedMicros: 0n });
      expect((await s.reserve("r2", keys, 1n, FAR)).ok).toBe(false);
    });

    test("release returns the reservation without spending", async () => {
      const s = make();
      const keys = [{ key: "job:a", limitMicros: 1000n }];
      await s.reserve("r1", keys, 900n, FAR);
      expect(await s.release("r1")).toBe(true);
      expect(await s.release("r1")).toBe(false);
      expect(await s.usage("job:a")).toEqual({ usedMicros: 0n, reservedMicros: 0n });
      expect((await s.reserve("r2", keys, 900n, FAR)).ok).toBe(true);
    });

    test("settling an unknown or already-settled reservation fails loudly", async () => {
      const s = make();
      await expect(s.settle("nope", 1n)).rejects.toThrow(UnknownReservationError);
      await s.reserve("r1", [{ key: "job:a", limitMicros: 10n }], 5n, FAR);
      await s.settle("r1", 5n);
      await expect(s.settle("r1", 5n)).rejects.toThrow(UnknownReservationError);
      expect(await s.usage("job:a")).toEqual({ usedMicros: 5n, reservedMicros: 0n });
    });

    test("a reservation id cannot be reused while it is open", async () => {
      const s = make();
      const keys = [{ key: "job:a", limitMicros: 100n }];
      await s.reserve("r1", keys, 5n, FAR);
      await expect(s.reserve("r1", keys, 5n, FAR)).rejects.toThrow(DuplicateReservationError);
      expect(await s.usage("job:a")).toEqual({ usedMicros: 0n, reservedMicros: 5n });
    });

    test("expired reservations are reaped; live ones are kept", async () => {
      const s = make();
      const keys = [{ key: "job:a", limitMicros: 1000n }];
      await s.reserve("old", keys, 300n, 1_000);
      await s.reserve("live", keys, 300n, 9_000);
      expect(await s.reapExpired(5_000)).toBe(1);
      expect(await s.usage("job:a")).toEqual({ usedMicros: 0n, reservedMicros: 300n });
      await expect(s.settle("old", 1n)).rejects.toThrow(UnknownReservationError);
      expect((await s.settle("live", 200n)).actualMicros).toBe(200n);
    });

    test("large amounts stay exact", async () => {
      const s = make();
      const big = 5_000_000_000_000n; // $5M in micro-dollars
      const keys = [{ key: "global", limitMicros: big }];
      expect((await s.reserve("r1", keys, big - 1n, FAR)).ok).toBe(true);
      await s.settle("r1", big - 1n);
      expect(await s.usage("global")).toEqual({ usedMicros: big - 1n, reservedMicros: 0n });
      expect((await s.reserve("r2", keys, 2n, FAR)).ok).toBe(false);
      expect((await s.reserve("r3", keys, 1n, FAR)).ok).toBe(true);
    });

    test("negative amounts are rejected", async () => {
      const s = make();
      await expect(s.reserve("r1", [{ key: "k", limitMicros: 10n }], -1n, FAR)).rejects.toThrow();
    });
  });
}

describe("budget keys (§13)", () => {
  const limits: BudgetLimits = {
    accountDayMicros: 50_000_000n,
    laneDayMicros: { priority: 1n, paid: 2n, free: 3n, deferred: 4n },
    globalDayMicros: 9n,
    freeTierDayMicros: 7n,
    roleShareBps: { planner: 2000 },
  };
  const scope = {
    jobKey: "0xabc",
    quoteMicros: 1_485_000n,
    role: "worker",
    accountId: "acct",
    lane: "paid",
    freeTier: false,
    day: "2026-11-15",
  } as const;

  test("a paid call is held to job, role-job, account-day, lane-day and global-day", () => {
    expect(budgetKeys(scope, limits)).toEqual([
      { key: "job:0xabc", limitMicros: 1_485_000n },
      { key: "role-job:0xabc:worker", limitMicros: 1_485_000n },
      { key: "account-day:acct:2026-11-15", limitMicros: 50_000_000n },
      { key: "lane-day:paid:2026-11-15", limitMicros: 2n },
      { key: "global-day:2026-11-15", limitMicros: 9n },
    ]);
    expect(jobBudgetKey("0xabc")).toBe("job:0xabc");
  });

  test("a free job is also held to the free-tier daily budget", () => {
    const keys = budgetKeys({ ...scope, lane: "free", freeTier: true }, limits);
    expect(keys.at(-1)).toEqual({ key: "free-tier-day:2026-11-15", limitMicros: 7n });
  });

  test("the job cap is the quote; a role share narrows only the role key", () => {
    const keys = budgetKeys({ ...scope, role: "planner" }, limits);
    expect(keys[0]!.limitMicros).toBe(1_485_000n);
    expect(keys[1]).toEqual({ key: "role-job:0xabc:planner", limitMicros: 297_000n });
  });

  test("days are UTC", () => {
    expect(utcDay(Date.UTC(2026, 10, 15, 23, 59, 59))).toBe("2026-11-15");
    expect(utcDay(Date.UTC(2026, 10, 16, 0, 0, 0))).toBe("2026-11-16");
  });
});
