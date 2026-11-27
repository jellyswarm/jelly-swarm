import { describe, expect, test } from "bun:test";
import { lintText } from "./lint";

const rules = (text: string) => lintText("x.copy.ts", text).map((f) => f.rule);

describe("copy lint (§0.8)", () => {
  test.each([
    ["Get 12% APY on idle funds", "banned:apy"],
    ["low apr", "banned:apr"],
    ["Stake to yield more", "banned:yield"],
    ["Earn credits", "banned:earn"],
    ["a source of passive income", "banned:passive-income"],
    ["Results are guaranteed", "banned:guaranteed"],
    ["our partners at Example", "banned:partner"],
    ["watched 24/7", "banned:24/7"],
    ["watched 24x7", "banned:24/7"],
    ["247 agents work for you", "cap:247-wording"],
    ["powered by Muster", "brand:internal"],
    ["routed via Offpeak", "brand:internal"],
  ])("flags %p", (text, rule) => {
    expect(rules(text)).toContain(rule);
  });

  test.each([
    "This job will use 183 of 247 agents",
    "Up to 247 agents do the work",
    "Watched around the clock",
    "Learn how the checker works", // "learn" is not "earn"
    "Friends who run a job from your link get you job credits",
    "A cell the checker can't verify shows \"unverified\"",
    "$49 a month for 247 targets",
  ])("allows %p", (text) => {
    expect(rules(text)).toEqual([]);
  });

  test("reports the line number", () => {
    const [f] = lintText("a/copy.ts", "ok\nok\nbest yield\n");
    expect(f).toMatchObject({ file: "a/copy.ts", line: 3, rule: "banned:yield" });
  });

  test("an explicit ignore marker skips the line", () => {
    expect(rules('const banned = ["yield"]; // copy-lint-ignore: the word list itself')).toEqual([]);
  });
});
