import { afterAll, describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { Redis } from "ioredis";
import { type Dispatch, MemorySemaphore, RedisSemaphore, type SchedJob, Scheduler, type Semaphore } from "./index";

const job = (jobKey: string, over: Partial<SchedJob> = {}): SchedJob => ({
  jobKey,
  accountId: jobKey,
  accountTier: "paid",
  lane: "paid",
  rows: 10,
  maxAgents: 247,
  ...over,
});

/** Takes every row the scheduler will hand out right now. */
const takeAll = (s: Scheduler): Dispatch[] => {
  const out: Dispatch[] = [];
  for (let d = s.next(); d; d = s.next()) out.push(d);
  return out;
};

const finish = (s: Scheduler, ds: Dispatch[]) => {
  for (const d of ds) s.complete(d.jobKey, d.rowIdx, "final");
};

describe("waves and per-job width", () => {
  test("600 rows go out as 3 waves and never more than 247 at once", () => {
    const waves: [number, number][] = [];
    const s = new Scheduler({ globalAgents: 10_000 }, { onWaveStarted: (_k, w) => waves.push([w.from, w.to]) });
    s.submit(job("a", { rows: 600 }));

    const w0 = takeAll(s);
    expect(w0).toHaveLength(247);
    expect(s.rowsInFlight).toBe(247);
    expect(w0.every((d) => d.wave === 0 && d.rowIdx <= 246)).toBe(true);

    finish(s, w0.slice(0, 246));
    expect(takeAll(s)).toHaveLength(0); // the next wave waits for the last row of this one
    finish(s, w0.slice(246));

    const w1 = takeAll(s);
    expect(w1.map((d) => d.rowIdx)).toEqual(Array.from({ length: 247 }, (_, i) => 247 + i));
    finish(s, w1);
    const w2 = takeAll(s);
    expect(w2).toHaveLength(106);
    finish(s, w2);

    expect(waves).toEqual([
      [0, 246],
      [247, 493],
      [494, 599],
    ]);
    expect(s.isScheduled("a")).toBe(false);
    expect(s.rowsInFlight).toBe(0);
  });

  test("a job never runs more rows at once than its own agent count", () => {
    const s = new Scheduler({ globalAgents: 10_000 });
    s.submit(job("a", { rows: 100, maxAgents: 10 }));
    const first = takeAll(s);
    expect(first).toHaveLength(10);
    s.complete("a", first[0]!.rowIdx, "final");
    expect(takeAll(s)).toHaveLength(1);
  });

  test("more than 247 agents is refused", () => {
    const s = new Scheduler({ globalAgents: 10_000 });
    expect(() => s.submit(job("a", { maxAgents: 248 }))).toThrow();
  });

  test("the heartbeat can halve the width", () => {
    const s = new Scheduler({ globalAgents: 10_000 });
    s.submit(job("a", { rows: 100, maxAgents: 20 }));
    s.setWidthFactor("a", 0.5);
    expect(takeAll(s)).toHaveLength(10);
  });

  test("a retry goes back to the front of its wave as attempt 1", () => {
    const s = new Scheduler({ globalAgents: 10_000 });
    s.submit(job("a", { rows: 3, maxAgents: 1 }));
    const d = s.next()!;
    expect(d).toMatchObject({ rowIdx: 0, attempt: 0 });
    s.complete("a", 0, "retry");
    expect(s.next()).toMatchObject({ rowIdx: 0, attempt: 1 });
    s.complete("a", 0, "final");
    expect(s.next()).toMatchObject({ rowIdx: 1, attempt: 0 });
  });

  test("drain returns every row that has not started, across later waves", () => {
    const s = new Scheduler({ globalAgents: 5 });
    s.submit(job("a", { rows: 300 }));
    const running = takeAll(s);
    expect(running).toHaveLength(5);
    const dropped = s.drain("a");
    expect(dropped).toHaveLength(295);
    expect(new Set(dropped).size).toBe(295);
    expect(s.isScheduled("a")).toBe(true); // 5 rows still in flight
    finish(s, running);
    expect(s.isScheduled("a")).toBe(false);
    expect(takeAll(s)).toHaveLength(0);
  });
});

describe("lanes and global capacity (§12.3)", () => {
  test("rows in flight never exceed the global target", () => {
    const s = new Scheduler({ globalAgents: 30 });
    s.submit(job("a", { rows: 200 }));
    s.submit(job("b", { rows: 200 }));
    expect(takeAll(s)).toHaveLength(30);
    expect(s.next()).toBeNull();
  });

  test("lanes are strict: priority, then paid, then free, then deferred", () => {
    const s = new Scheduler({ globalAgents: 1 });
    s.submit(job("deferred", { lane: "deferred", rows: 2 }));
    s.submit(job("free", { lane: "free", accountTier: "free", rows: 2 }));
    s.submit(job("paid", { lane: "paid", rows: 2 }));
    s.submit(job("priority", { lane: "priority", accountTier: "holder", rows: 2 }));
    const order: string[] = [];
    for (let d = s.next(); d; d = s.next()) {
      order.push(d.jobKey);
      s.complete(d.jobKey, d.rowIdx, "final");
    }
    expect(order).toEqual(["priority", "priority", "paid", "paid", "free", "free", "deferred", "deferred"]);
  });

  test("a free job runs when paid work is blocked by its own width, not only when the paid lane is empty", () => {
    const s = new Scheduler({ globalAgents: 10 });
    s.submit(job("paid", { rows: 100, maxAgents: 2 }));
    s.submit(job("free", { lane: "free", accountTier: "free", rows: 100 }));
    const ds = takeAll(s);
    expect(ds.filter((d) => d.jobKey === "paid")).toHaveLength(2);
    expect(ds.filter((d) => d.jobKey === "free")).toHaveLength(8);
  });
});

describe("fair share inside a lane", () => {
  test("one heavy account cannot starve the others", () => {
    const s = new Scheduler({ globalAgents: 20 });
    s.submit(job("heavy", { rows: 2000 }));
    for (let i = 0; i < 5; i++) s.submit(job(`light-${i}`, { rows: 10 }));

    // Run the system: keep capacity full, finishing the oldest row each step.
    const order: string[] = [];
    const inFlight: Dispatch[] = [];
    const lightDoneAt = new Map<string, number>();
    while (lightDoneAt.size < 5) {
      for (let d = s.next(); d; d = s.next()) {
        order.push(d.jobKey);
        inFlight.push(d);
      }
      const d = inFlight.shift()!;
      s.complete(d.jobKey, d.rowIdx, "final");
      if (d.jobKey !== "heavy" && !s.isScheduled(d.jobKey)) lightDoneAt.set(d.jobKey, order.length);
    }

    // All 50 light rows are out within the first ~2 rounds of 6 accounts × 8 rows,
    // while the heavy account has barely started on its 2000.
    const lastLight = Math.max(...lightDoneAt.values());
    expect(lastLight).toBeLessThan(150);
    expect(order.slice(0, lastLight).filter((k) => k === "heavy").length).toBeLessThan(100);
    expect(s.isScheduled("heavy")).toBe(true);
  });

  test("accounts with equal work get equal turns", () => {
    const s = new Scheduler({ globalAgents: 1, quantum: 4 });
    s.submit(job("a", { rows: 40 }));
    s.submit(job("b", { rows: 40 }));
    const first24: string[] = [];
    for (let i = 0; i < 24; i++) {
      const d = s.next()!;
      first24.push(d.jobKey);
      s.complete(d.jobKey, d.rowIdx, "final");
    }
    expect(first24.filter((k) => k === "a")).toHaveLength(12);
    expect(first24.join("")).toBe("aaaabbbb".repeat(3));
  });

  test("one account's jobs share its turn; they do not multiply its share", () => {
    const s = new Scheduler({ globalAgents: 1, quantum: 4 });
    s.submit(job("a1", { accountId: "A", rows: 40 }));
    s.submit(job("a2", { accountId: "A", rows: 40 }));
    s.submit(job("b1", { accountId: "B", rows: 40 }));
    const counts = { A: 0, B: 0 };
    for (let i = 0; i < 40; i++) {
      const d = s.next()!;
      counts[d.accountId as "A" | "B"]++;
      s.complete(d.jobKey, d.rowIdx, "final");
    }
    expect(counts).toEqual({ A: 20, B: 20 });
  });
});

describe("per-account concurrent jobs", () => {
  const limits = [
    ["free", 1],
    ["paid", 5],
    ["holder", 10],
  ] as const;

  test.each(limits)("a %s account runs at most %d jobs at once; the rest wait", (tier, limit) => {
    const started: string[] = [];
    const s = new Scheduler({ globalAgents: 10_000 }, { onJobActivated: (k) => started.push(k) });
    for (let i = 0; i < limit + 2; i++) {
      s.submit(job(`j${i}`, { accountId: "acct", accountTier: tier, lane: tier === "free" ? "free" : "paid", rows: 1 }));
    }
    expect(started).toHaveLength(limit);
    const running = takeAll(s);
    expect(running).toHaveLength(limit);

    s.complete(running[0]!.jobKey, running[0]!.rowIdx, "final");
    expect(started).toHaveLength(limit + 1); // a waiting job takes the freed slot
    expect(started.at(-1)).toBe(`j${limit}`);
  });

  test("another account is not held back by a neighbour at its limit", () => {
    const s = new Scheduler({ globalAgents: 10_000 });
    s.submit(job("f1", { accountId: "F", accountTier: "free", lane: "free", rows: 1 }));
    s.submit(job("f2", { accountId: "F", accountTier: "free", lane: "free", rows: 1 }));
    s.submit(job("g1", { accountId: "G", accountTier: "free", lane: "free", rows: 1 }));
    expect(takeAll(s).map((d) => d.jobKey).sort()).toEqual(["f1", "g1"]);
  });
});

describe("admission control (§12.3)", () => {
  test("ETA is lane depth × p50 row time over global capacity", () => {
    const s = new Scheduler({ globalAgents: 100, p50RowMs: 20_000 });
    s.submit(job("p", { rows: 1000 }));
    expect(s.admission("paid").etaSec).toBe(200);
    expect(s.admission("priority").etaSec).toBe(0); // nothing ahead of the priority lane
  });

  test("free jobs switch to 'join queue' past 30 minutes and pause past 3 hours", () => {
    const mode = (rows: number) => {
      const s = new Scheduler({ globalAgents: 10, p50RowMs: 20_000 });
      for (let i = 0; i < rows / 2000; i++) s.submit(job(`f${i}`, { accountTier: "free", lane: "free", rows: 2000 }));
      return s.admission("free");
    };
    expect(mode(0)).toEqual({ etaSec: 0, freeMode: "open" });
    expect(mode(2000).freeMode).toBe("queue"); // 4000 s
    expect(mode(6000).freeMode).toBe("paused"); // 12000 s
  });
});

// ───────────────────────────── semaphore ─────────────────────────────

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

let n = 0;
const semaphores: [string, boolean, () => Semaphore][] = [
  ["memory", true, () => new MemorySemaphore()],
  ["redis", redisUp, () => new RedisSemaphore(redis, `semtest:${process.pid}:${Date.now()}:${n++}:`)],
];

for (const [name, available, make] of semaphores) {
  describe.skipIf(!available)(`semaphore: ${name}`, () => {
    test("holds at most `limit` holders, even under 400 concurrent requests", async () => {
      const sem = make();
      const got = await Promise.all(Array.from({ length: 400 }, (_, i) => sem.acquire("job", `h${i}`, 247, 1000, 9000)));
      expect(got.filter(Boolean)).toHaveLength(247);
      expect(await sem.count("job", 1000)).toBe(247);
    });

    test("release frees a slot; re-acquiring as the same holder is a no-op", async () => {
      const sem = make();
      expect(await sem.acquire("job", "a", 1, 1000, 9000)).toBe(true);
      expect(await sem.acquire("job", "a", 1, 1000, 9000)).toBe(true);
      expect(await sem.acquire("job", "b", 1, 1000, 9000)).toBe(false);
      await sem.release("job", "a");
      expect(await sem.acquire("job", "b", 1, 1000, 9000)).toBe(true);
    });

    test("a holder that never releases expires", async () => {
      const sem = make();
      await sem.acquire("job", "crashed", 1, 1000, 2000);
      expect(await sem.acquire("job", "b", 1, 1999, 9000)).toBe(false);
      expect(await sem.acquire("job", "b", 1, 2000, 9000)).toBe(true);
      expect(await sem.count("job", 2000)).toBe(1);
    });
  });
}
