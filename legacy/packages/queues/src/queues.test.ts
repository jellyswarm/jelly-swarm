import { afterAll, describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { Redis } from "ioredis";
import { DEFAULT_JOB_OPTIONS, QUEUES, createQueue, dlqName, rowJobId, rowJobOptions, rowsQueue } from "./index";

describe("queue conventions (§7)", () => {
  test("names are lower-case and hyphenated, with no colons", () => {
    for (const q of QUEUES) expect(q).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(QUEUES).size).toBe(QUEUES.length);
  });

  test("there is one rows queue per lane", () => {
    expect((["priority", "paid", "free", "deferred"] as const).map(rowsQueue)).toEqual([
      "rows-priority",
      "rows-paid",
      "rows-free",
      "rows-deferred",
    ]);
  });

  test("defaults: 3 attempts, exponential backoff, keep the last 1000 completed", () => {
    expect(DEFAULT_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential" },
      removeOnComplete: 1000,
    });
    expect(dlqName("row-check")).toBe("row-check-dlq");
  });

  test("row jobs get a deterministic id and their lane's priority", () => {
    expect(rowJobId("0xabc", 12, 1)).toBe("0xabc-12-1");
    expect(rowJobOptions("0xabc", 12, 0, "priority")).toMatchObject({ jobId: "0xabc-12-0", priority: 1 });
    expect(rowJobOptions("0xabc", 12, 0, "paid").priority).toBe(2);
    expect(rowJobOptions("0xabc", 12, 0, "free").priority).toBe(5);
    expect(rowJobOptions("0xabc", 12, 0, "deferred").priority).toBe(10);
  });
});

// Needs the docker-compose Redis; skipped when unreachable unless REQUIRE_INFRA=1.
const url = loadInfraEnv().REDIS_URL;
const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 1500 });
probe.on("error", () => {});
const redisUp = await probe.connect().then(
  () => true,
  () => false,
);
probe.disconnect();
if (!redisUp && process.env.REQUIRE_INFRA === "1") throw new Error("REQUIRE_INFRA=1 but Redis is not reachable");

describe.skipIf(!redisUp)("BullMQ against Redis", () => {
  const { hostname, port } = new URL(url);
  const queue = createQueue<{ rowIdx: number }>("rows-paid", { host: hostname, port: Number(port) }, {
    prefix: `qtest-${process.pid}-${Date.now()}`,
  });
  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  test("adding the same row attempt twice enqueues it once", async () => {
    await queue.add("row", { rowIdx: 3 }, rowJobOptions("0xjob", 3, 0, "paid"));
    await queue.add("row", { rowIdx: 3 }, rowJobOptions("0xjob", 3, 0, "paid"));
    await queue.add("row", { rowIdx: 3 }, rowJobOptions("0xjob", 3, 1, "paid"));
    const counts = await queue.getJobCounts("waiting", "prioritized");
    expect((counts.waiting ?? 0) + (counts.prioritized ?? 0)).toBe(2);
  });
});
