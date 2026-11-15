import { describe, expect, test } from "bun:test";
import { keccak256, toBytes } from "viem";
import { EVENT_VERSION, InMemoryEventBus, TileCoalescer, Tile as TileSchema, encodeTilesBatch, filterEvent, isVisibleOn } from "./index";

const jobKey = keccak256(toBytes("job-1"));

describe("event schema (§11.2)", () => {
  test("every event carries the version", () => {
    expect(TileSchema.parse({ v: 1, agentIdx: 1, rowIdx: 0, state: "working" })).toMatchObject({ v: EVENT_VERSION });
    expect(() => TileSchema.parse({ agentIdx: 1, rowIdx: 0, state: "working" })).toThrow();
  });

  test("a tile batch encodes one byte per agent, 1..247", () => {
    const b64 = encodeTilesBatch(new Map([[1, "working"], [247, "passed"]]));
    const bytes = Buffer.from(b64, "base64");
    expect(bytes.length).toBe(247);
    expect(bytes[0]).toBe(2); // "working"
    expect(bytes[246]).toBe(4); // "passed"
    expect(bytes[100]).toBe(0); // untouched
  });
});

describe("channel rules (§11.2)", () => {
  const owner = { channel: "owner" as const, walletJob: false, visibility: "private" as const };
  const pub = { channel: "public" as const, walletJob: false, visibility: "unlisted" as const };

  test("the owner channel sees everything, including a wallet job's rows", () => {
    expect(isVisibleOn("row", { ...owner, walletJob: true })).toBe(true);
    expect(isVisibleOn("tile", owner)).toBe(true);
  });

  test("a wallet job has no public channel at all", () => {
    for (const type of ["tile", "cost", "eta", "job.merged"] as const) {
      expect(isVisibleOn(type, { ...pub, walletJob: true })).toBe(false);
    }
  });

  test("the public channel sees tile, cost and eta, but never row cells unless the share is public", () => {
    expect(isVisibleOn("tile", pub)).toBe(true);
    expect(isVisibleOn("cost", pub)).toBe(true);
    expect(isVisibleOn("row", pub)).toBe(false);
    expect(isVisibleOn("row", { ...pub, visibility: "public" })).toBe(true);
    expect(isVisibleOn("row", { ...pub, visibility: "private" })).toBe(false);
  });

  test("filterEvent returns the payload or null consistently with isVisibleOn", () => {
    expect(filterEvent("row", { cells: {} }, pub)).toBeNull();
    expect(filterEvent("tile", { state: "working" }, pub)).toEqual({ state: "working" });
  });
});

describe("TileCoalescer (§11.2 'coalesced to at most 10/s')", () => {
  test("up to the per-second budget, individual tile events are allowed through", () => {
    const clock = { now: 0 };
    const tiles = new TileCoalescer(10, () => clock.now);
    let allowed = 0;
    for (let i = 0; i < 15; i++) if (tiles.record((i % 247) + 1, "working")) allowed++;
    expect(allowed).toBe(10);
  });

  test("the budget refills over time", () => {
    const clock = { now: 0 };
    const tiles = new TileCoalescer(10, () => clock.now);
    for (let i = 0; i < 10; i++) tiles.record(i + 1, "working");
    expect(tiles.record(11, "working")).toBe(false);
    clock.now += 500; // half a second: 5 tokens back
    let allowed = 0;
    for (let i = 0; i < 6; i++) if (tiles.record(i + 1, "checking")) allowed++;
    expect(allowed).toBe(5);
  });

  test("a snapshot reflects the latest state per agent, and changed-tile tracking drains once", () => {
    const tiles = new TileCoalescer();
    tiles.record(1, "working");
    tiles.record(1, "checking"); // overwrites, still one agent
    tiles.record(2, "passed");
    const snap = Buffer.from(tiles.snapshotBase64(), "base64");
    expect(snap[0]).toBe(3); // checking
    expect(snap[1]).toBe(4); // passed
    expect(tiles.drainChanged().sort((a, b) => a - b)).toEqual([1, 2]);
    expect(tiles.drainChanged()).toEqual([]); // drained
  });
});

describe("InMemoryEventBus", () => {
  test("publishes only to subscribers of the same job", () => {
    const bus = new InMemoryEventBus();
    const other = keccak256(toBytes("job-2"));
    const seen: unknown[] = [];
    const unsub = bus.subscribe(jobKey, (e) => seen.push(e));
    bus.subscribe(other, (e) => seen.push(e));
    bus.publish(jobKey, { seq: 1, ts: 0, type: "tile", payload: {} });
    expect(seen).toHaveLength(1);
    unsub();
    bus.publish(jobKey, { seq: 2, ts: 0, type: "tile", payload: {} });
    expect(seen).toHaveLength(1); // unsubscribed
    expect(bus.subscriberCount(jobKey)).toBe(0);
  });

  test("multiple subscribers on one job all get the event", () => {
    const bus = new InMemoryEventBus();
    let a = 0;
    let b = 0;
    bus.subscribe(jobKey, () => a++);
    bus.subscribe(jobKey, () => b++);
    bus.publish(jobKey, { seq: 1, ts: 0, type: "cost", payload: {} });
    expect([a, b]).toEqual([1, 1]);
  });
});
