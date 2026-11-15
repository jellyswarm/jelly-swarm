import { describe, expect, test } from "bun:test";
import { MemoryFundingGraph, NullFundingGraph } from "./index";

const STUDIO = new Set(["0xstudio"]);
const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;

describe("MemoryFundingGraph (§8)", () => {
  test("a studio wallet itself is studio-linked at hop 0", async () => {
    const g = new MemoryFundingGraph();
    expect(await g.isStudioLinked("0xstudio", STUDIO, 3, 30 * DAY, NOW)).toBe(true);
  });

  test("an address funded directly by a studio wallet is linked at hop 1", async () => {
    const g = new MemoryFundingGraph([{ from: "0xstudio", to: "0xA", atMs: NOW - DAY }]);
    expect(await g.isStudioLinked("0xA", STUDIO, 3, 30 * DAY, NOW)).toBe(true);
  });

  test("a chain of funding up to the hop limit is linked; one hop further is not", async () => {
    const g = new MemoryFundingGraph([
      { from: "0xstudio", to: "0xA", atMs: NOW - DAY },
      { from: "0xA", to: "0xB", atMs: NOW - DAY },
      { from: "0xB", to: "0xC", atMs: NOW - DAY }, // hop 3 from studio
      { from: "0xC", to: "0xD", atMs: NOW - DAY }, // hop 4
    ]);
    expect(await g.isStudioLinked("0xC", STUDIO, 3, 30 * DAY, NOW)).toBe(true);
    expect(await g.isStudioLinked("0xD", STUDIO, 3, 30 * DAY, NOW)).toBe(false);
  });

  test("a funding edge outside the lookback window does not count", async () => {
    const g = new MemoryFundingGraph([{ from: "0xstudio", to: "0xA", atMs: NOW - 31 * DAY }]);
    expect(await g.isStudioLinked("0xA", STUDIO, 3, 30 * DAY, NOW)).toBe(false);
  });

  test("an edge dated after the classification time does not count (no time travel)", async () => {
    const g = new MemoryFundingGraph([{ from: "0xstudio", to: "0xA", atMs: NOW + DAY }]);
    expect(await g.isStudioLinked("0xA", STUDIO, 3, 30 * DAY, NOW)).toBe(false);
  });

  test("an unrelated wallet, funded only by other unrelated wallets, is not linked", async () => {
    const g = new MemoryFundingGraph([{ from: "0xX", to: "0xY", atMs: NOW - DAY }]);
    expect(await g.isStudioLinked("0xY", STUDIO, 3, 30 * DAY, NOW)).toBe(false);
  });

  test("case is ignored for addresses", async () => {
    const g = new MemoryFundingGraph([{ from: "0xSTUDIO", to: "0xa", atMs: NOW - DAY }]);
    expect(await g.isStudioLinked("0xA", new Set(["0xstudio"]), 3, 30 * DAY, NOW)).toBe(true);
  });

  test("a cycle in the funding graph terminates instead of looping forever", async () => {
    const g = new MemoryFundingGraph([
      { from: "0xA", to: "0xB", atMs: NOW - DAY },
      { from: "0xB", to: "0xA", atMs: NOW - DAY },
    ]);
    expect(await g.isStudioLinked("0xA", STUDIO, 3, 30 * DAY, NOW)).toBe(false);
  });
});

describe("NullFundingGraph", () => {
  test("never links anything to the studio", async () => {
    expect(await new NullFundingGraph().isStudioLinked("0xA", STUDIO, 3, 30 * DAY, NOW)).toBe(false);
  });
});
