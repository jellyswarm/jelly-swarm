import { describe, expect, test } from "bun:test";
import { keccak256, toBytes } from "viem";
import { needsAudit, sampleRows } from "./index";

describe("needsAudit (§3.3 step 8)", () => {
  test("every job of $50 or more is always audited, whatever the sample draws", () => {
    for (let i = 0; i < 50; i++) {
      const jobKey = keccak256(toBytes(`job-${i}`));
      expect(needsAudit(jobKey, 50_000_000n)).toBe(true);
      expect(needsAudit(jobKey, 100_000_000n)).toBe(true);
    }
  });

  test("a job just under $50 can still go either way, by the sample", () => {
    const outcomes = new Set<boolean>();
    for (let i = 0; i < 2000; i++) outcomes.add(needsAudit(keccak256(toBytes(`sample-${i}`)), 49_999_999n));
    expect(outcomes).toEqual(new Set([true, false]));
  });

  test("about 5% of small jobs are sampled, and the result is deterministic for the same job key", () => {
    let audited = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const jobKey = keccak256(toBytes(`vol-${i}`));
      if (needsAudit(jobKey, 1n)) audited++;
      // Same key, same amount, same answer: anyone can recompute the keeper's decision.
      expect(needsAudit(jobKey, 1n)).toBe(needsAudit(jobKey, 1n));
    }
    expect(audited / n).toBeGreaterThan(0.04);
    expect(audited / n).toBeLessThan(0.06);
  });

  test("the sample rate and the always-audit threshold are both configurable", () => {
    const jobKey = keccak256(toBytes("job-x"));
    expect(needsAudit(jobKey, 10n, 10_000)).toBe(true); // 100% sample
    expect(needsAudit(jobKey, 10n, 0)).toBe(false); // 0% sample, under the threshold
    expect(needsAudit(jobKey, 10n, 0, 10n)).toBe(true); // threshold lowered to the job's own amount
  });
});

describe("sampleRows", () => {
  test("when there is room for everything, the output is every row in ascending order", () => {
    const states = ["passed", "refunded", "passed", "refunded", "passed"] as const;
    expect(sampleRows(states, 10)).toEqual([0, 1, 2, 3, 4]);
  });

  test("the sample is capped, favouring failed rows when there are more candidates than room", () => {
    const states = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? "refunded" : "passed")) as ("passed" | "refunded")[];
    const sample = sampleRows(states, 5);
    expect(sample).toHaveLength(5);
    expect(sample.every((i) => states[i] === "refunded")).toBe(true); // 10 failed rows exist; all 5 slots go to them
  });

  test("an all-passed job still samples some rows, up to the cap", () => {
    const states = Array.from({ length: 300 }, () => "passed" as const);
    expect(sampleRows(states, 25)).toHaveLength(25);
  });
});
