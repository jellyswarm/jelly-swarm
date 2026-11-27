import { describe, expect, test } from "bun:test";
import { hashLabel } from "@jelly/receipts";
import { MAX_AGENTS, formatUsd6, usd6 } from "@jelly/shared";
import { privateKeyToAccount } from "viem/accounts";
import {
  type AccountInspector,
  JobSpec,
  PricingError,
  QuoteRefused,
  Quoter,
  type SampleCost,
  TIER_ID,
  applyWalletRule,
  classifyItem,
  detectWallets,
  estimateFromSample,
  expiryMs,
  jobWallClockMs,
  normalizeItems,
  planWaves,
  plannerBudgetMicros,
  priceJob,
  quoteTotalUsd6,
  settlementAmounts,
  specHash,
  verifyQuote,
} from "./index";

const quoter = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const EOA = "0x000000000000000000000000000000000000dead";
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SOL_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const inspector: AccountInspector = {
  evmCodeSize: async (_c, a) => (a === TOKEN ? 1234 : 0),
  solanaAccountKind: async (a) => (a === SOL_MINT ? "mint" : a === SOL_WALLET ? "wallet" : "missing"),
};

const spec = (items: string[], over: Partial<JobSpec> = {}): JobSpec => ({
  product: "fanout",
  task: "Find the holder count for each token.",
  items: normalizeItems(items),
  columns: [{ name: "holders", type: "number", needsSource: true }],
  tier: "standard",
  maxAgents: MAX_AGENTS,
  ...over,
});
const tokens = (n: number) => Array.from({ length: n }, (_, i) => `token-${i}`);

describe("job spec (§3.1)", () => {
  test("items are trimmed, de-duplicated and classified", () => {
    expect(normalizeItems([` ${TOKEN.toUpperCase().replace("0X", "0x")} `, TOKEN, "", "  ", SOL_MINT, "https://a.example/x", "cheap flights"])).toEqual([
      { raw: TOKEN, kind: "evm_address" },
      { raw: SOL_MINT, kind: "solana_address", chain: "solana" },
      { raw: "https://a.example/x", kind: "url" },
      { raw: "cheap flights", kind: "text" },
    ]);
    expect(classifyItem(EOA, "base")).toEqual({ raw: EOA, kind: "evm_address", chain: "base" });
  });

  test("more than 247 agents, no items, or duplicate columns are rejected", () => {
    expect(() => JobSpec.parse(spec(["a"], { maxAgents: 248 }))).toThrow();
    expect(() => JobSpec.parse(spec([]))).toThrow();
    expect(() =>
      JobSpec.parse(
        spec(["a"], {
          columns: [
            { name: "Holders", type: "number", needsSource: true },
            { name: "holders", type: "text", needsSource: false },
          ],
        }),
      ),
    ).toThrow();
    expect(JobSpec.parse(spec(["a"])).maxAgents).toBe(247);
  });

  test("the spec hash ignores key order and changes with content", () => {
    const a = spec(["a", "b"]);
    const reordered = { maxAgents: a.maxAgents, tier: a.tier, columns: a.columns, items: a.items, task: a.task, product: a.product } as JobSpec;
    expect(specHash(reordered)).toBe(specHash(a));
    expect(specHash(spec(["a", "c"]))).not.toBe(specHash(a));
  });
});

describe("wallet rule (§0.7)", () => {
  test("an EVM address with no code and a Solana non-program, non-mint account are wallets", async () => {
    const items = normalizeItems([TOKEN, EOA, SOL_MINT, SOL_WALLET, "plain text"]);
    expect(await detectWallets(items, inspector, "base")).toEqual({ walletJob: true, walletItems: [1, 3] });
    expect(await detectWallets(normalizeItems([TOKEN, SOL_MINT, "x"]), inspector, "base")).toEqual({
      walletJob: false,
      walletItems: [],
    });
  });

  test("it fails closed: a lookup error or an unknown Solana account counts as a wallet", async () => {
    const broken: AccountInspector = {
      evmCodeSize: async () => {
        throw new Error("rpc down");
      },
      solanaAccountKind: async () => "missing",
    };
    expect((await detectWallets(normalizeItems([TOKEN]), broken, "base")).walletJob).toBe(true);
    expect((await detectWallets(normalizeItems([SOL_MINT]), broken, "base")).walletJob).toBe(true);
  });

  test("a wallet job is forced to Sealed whatever tier was asked for", async () => {
    for (const tier of ["open", "standard"] as const) {
      const r = await applyWalletRule(spec([TOKEN, EOA], { tier }), inspector, "base");
      expect(r).toMatchObject({ walletJob: true, tierForced: true });
      expect(r.spec.tier).toBe("sealed");
    }
    const already = await applyWalletRule(spec([EOA], { tier: "sealed" }), inspector, "base");
    expect(already).toMatchObject({ walletJob: true, tierForced: false });
    const none = await applyWalletRule(spec([TOKEN], { tier: "open" }), inspector, "base");
    expect(none.spec.tier).toBe("open");
  });
});

describe("pricebook (§3.2)", () => {
  const total = (...a: Parameters<typeof priceJob>) => formatUsd6(priceJob(...a).totalUsd6);

  test("Fanout: $0.25 + agents × per-agent rate", () => {
    expect(total("fanout.job", { tier: "open", pieces: 247, maxAgents: 247 })).toBe("1.485");
    expect(total("fanout.job", { tier: "standard", pieces: 247, maxAgents: 247 })).toBe("3.955");
    expect(total("fanout.job", { tier: "sealed", pieces: 247, maxAgents: 247 })).toBe("10.13");
    expect(total("fanout.job", { tier: "standard", pieces: 20, maxAgents: 247 })).toBe("0.55");
  });

  test("items beyond 247 are priced per piece and run in waves", () => {
    const lines = priceJob("fanout.job", { tier: "standard", pieces: 600, maxAgents: 247 });
    expect(lines).toMatchObject({ units: 600, agents: 247, waves: 3 });
    expect(formatUsd6(lines.totalUsd6)).toBe("9.25");
    expect(priceJob("fanout.job", { tier: "open", pieces: 600, maxAgents: 100 }).agents).toBe(100);
    expect(priceJob("fanout.job", { tier: "open", pieces: 5, maxAgents: 247 }).agents).toBe(5);
  });

  test("minimum: base = max(product base, min − units × unit)", () => {
    const small = priceJob("trawl.token", { tier: "standard", pieces: 10, maxAgents: 247 });
    expect(small).toMatchObject({ unitUsd6: usd6("0.05"), baseUsd6: usd6("1.5"), totalUsd6: usd6("2") });
    const big = priceJob("trawl.token", { tier: "standard", pieces: 100, maxAgents: 247 });
    expect(big).toMatchObject({ baseUsd6: 0n, totalUsd6: usd6("5") });
    expect(total("trawl.token", { tier: "sealed", pieces: 10, maxAgents: 247 })).toBe("5.00");
    expect(total("trawl.wallet", { tier: "sealed", pieces: 3, maxAgents: 247 })).toBe("2.00");
    expect(total("trawl.wallet", { tier: "sealed", pieces: 10, maxAgents: 247 })).toBe("5.00");
  });

  test("flat prices become equal per-row slots that sum exactly to the flat price", () => {
    for (const pieces of [1, 5, 7, 13, 247]) {
      const l = priceJob("trawl.report", { tier: "standard", pieces, maxAgents: 247 });
      expect(l.totalUsd6).toBe(usd6("9"));
      expect(l.baseUsd6 + BigInt(pieces) * l.unitUsd6).toBe(usd6("9"));
      expect(l.baseUsd6).toBeLessThan(BigInt(pieces)); // only the division remainder
    }
    expect(total("trawl.everyday", { tier: "standard", pieces: 50, maxAgents: 247 })).toBe("3.00");
    expect(total("trawl.everyday", { tier: "standard", pieces: 51, maxAgents: 247 })).toBe("9.00");
  });

  test("a tier or size the product does not offer is refused", () => {
    expect(() => priceJob("trawl.wallet", { tier: "standard", pieces: 3, maxAgents: 247 })).toThrow(PricingError);
    expect(() => priceJob("trawl.token", { tier: "open", pieces: 3, maxAgents: 247 })).toThrow(PricingError);
    expect(() => priceJob("trawl.everyday", { tier: "standard", pieces: 248, maxAgents: 247 })).toThrow(PricingError);
    expect(() => priceJob("fanout.job", { tier: "open", pieces: 0, maxAgents: 247 })).toThrow(PricingError);
    expect(() => priceJob("fanout.job", { tier: "open", pieces: 5, maxAgents: 248 })).toThrow(PricingError);
  });

  test("tools are a separate line at cost plus 10%", () => {
    const l = priceJob("fanout.job", { tier: "standard", pieces: 20, maxAgents: 247, toolsEstimateUsd6: usd6("1") });
    expect(l.toolsCapUsd6).toBe(usd6("1.1"));
    expect(l.totalUsd6).toBe(usd6("1.65"));
    expect(priceJob("fanout.job", { tier: "open", pieces: 1, maxAgents: 1, toolsEstimateUsd6: 1n }).toolsCapUsd6).toBe(2n);
  });

  test("holder discount is at most 20% and never touches the tools line", () => {
    const l = priceJob("fanout.job", {
      tier: "standard",
      pieces: 247,
      maxAgents: 247,
      discountBps: 2000,
      toolsEstimateUsd6: usd6("1"),
    });
    expect(l).toMatchObject({ unitUsd6: usd6("0.012"), baseUsd6: usd6("0.2"), toolsCapUsd6: usd6("1.1") });
    expect(() => priceJob("fanout.job", { tier: "open", pieces: 1, maxAgents: 1, discountBps: 2001 })).toThrow(PricingError);
  });
});

describe("settlement amounts (§3.3 step 7)", () => {
  const lines = priceJob("trawl.token", { tier: "standard", pieces: 10, maxAgents: 247, toolsEstimateUsd6: usd6("1") });

  test("pay for passed rows, refund failed rows and unused tools", () => {
    // 10 tokens: unit 0.05, base 1.50, tools cap 1.10 → total 3.10
    expect(settlementAmounts(lines, 8, usd6("0.5"))).toEqual({
      grossUsd6: usd6("1.9"),
      toolsBilledUsd6: usd6("0.55"),
      refundUsd6: usd6("0.65"),
    });
  });

  test("if nothing passes, everything is refunded, base and tools included", () => {
    expect(settlementAmounts(lines, 0, usd6("0.9"))).toEqual({
      grossUsd6: 0n,
      toolsBilledUsd6: 0n,
      refundUsd6: lines.totalUsd6,
    });
  });

  test("tool spend above the cap is billed at the cap; the rest is ours", () => {
    expect(settlementAmounts(lines, 10, usd6("50")).toolsBilledUsd6).toBe(lines.toolsCapUsd6);
    expect(settlementAmounts(lines, 10, usd6("50")).refundUsd6).toBe(0n);
  });

  test("paid + refunded always equals the quote, and the client never pays more than it", () => {
    for (const key of ["fanout.job", "trawl.token", "trawl.report"] as const) {
      for (const pieces of [1, 2, 7, 60, 247]) {
        const l = priceJob(key, { tier: "standard", pieces, maxAgents: 247, toolsEstimateUsd6: 123_457n });
        for (const passed of [0, 1, Math.floor(pieces / 2), pieces]) {
          if (passed > pieces) continue;
          for (const tools of [0n, 1n, 100_000n, 10n ** 9n]) {
            const s = settlementAmounts(l, passed, tools);
            expect(s.grossUsd6 + s.toolsBilledUsd6 + s.refundUsd6).toBe(l.totalUsd6);
            expect(s.refundUsd6).toBeGreaterThanOrEqual(0n);
          }
        }
      }
    }
    expect(() => settlementAmounts(lines, 11, 0n)).toThrow(PricingError);
  });
});

describe("quotes (§3.2)", () => {
  const NOW = 1_800_000_000_000;
  const cheap: SampleCost = { costMicros: 1_000n, toolsUsd6: 0n };
  const make = (runSample = async () => cheap) => {
    const calls: number[] = [];
    const q = new Quoter({
      signer: quoter,
      inspector,
      now: () => NOW,
      runSample: async (_s, i) => {
        calls.push(i);
        return runSample();
      },
    });
    return { q, calls };
  };

  test("a quote is signed, lasts 10 minutes, and states the agents of 247", async () => {
    const { q, calls } = make();
    const r = await q.quote({ spec: spec(tokens(183)), pricebookKey: "fanout.job", chain: "base" });
    expect(calls).toEqual([0, 1, 2, 3, 4]); // dry run on a 5-item sample
    expect(r.quote).toMatchObject({
      units: 183,
      maxAgents: 183,
      tier: TIER_ID.standard,
      unitUsd6: usd6("0.015"),
      baseUsd6: usd6("0.25"),
      expiresAt: BigInt(NOW / 1000 + 600),
      chain: hashLabel("base"),
    });
    expect(quoteTotalUsd6(r.quote)).toBe(r.lines.totalUsd6);
    await verifyQuote("fanout", r.quote, r.signature, quoter.address, NOW);
  });

  test("a job smaller than the sample is sampled once per item", async () => {
    const { q, calls } = make();
    await q.quote({ spec: spec(tokens(2)), pricebookKey: "fanout.job", chain: "base" });
    expect(calls).toEqual([0, 1]);
  });

  test("a changed, expired, wrong-signer or wrong-product quote is rejected", async () => {
    const { q } = make();
    const r = await q.quote({ spec: spec(tokens(20)), pricebookKey: "fanout.job", chain: "base" });
    const refuse = (p: Promise<void>, reason: string) => expect(p.catch((e) => e.reason)).resolves.toBe(reason);
    await refuse(verifyQuote("fanout", { ...r.quote, unitUsd6: 1n }, r.signature, quoter.address, NOW), "bad_signature");
    await refuse(verifyQuote("fanout", r.quote, r.signature, stranger.address, NOW), "bad_signature");
    await refuse(verifyQuote("trawl", r.quote, r.signature, quoter.address, NOW), "bad_signature");
    await refuse(verifyQuote("fanout", r.quote, r.signature, quoter.address, NOW + 600_000), "expired");
    await verifyQuote("fanout", r.quote, r.signature, quoter.address, NOW + 599_000);
  });

  test("a wallet list is quoted as Sealed even when Standard was asked for", async () => {
    const { q } = make();
    const r = await q.quote({
      spec: spec([EOA, SOL_WALLET], { product: "trawl", tier: "standard" }),
      pricebookKey: "trawl.wallet",
      chain: "base",
    });
    expect(r).toMatchObject({ walletJob: true, tierForced: true });
    expect(r.spec.tier).toBe("sealed");
    expect(r.quote.tier).toBe(TIER_ID.sealed);
    expect(r.lines.totalUsd6).toBe(usd6("2"));
  });

  test("a job whose estimated cost is above 70% of (quote − fees) is refused, before signing", async () => {
    // 20 Standard agents: gross 0.55 → planner budget = 0.55 × 80% × 70% = 0.308
    const lines = priceJob("fanout.job", { tier: "standard", pieces: 20, maxAgents: 247 });
    expect(plannerBudgetMicros(lines)).toBe(308_000n);
    const { q } = make(async () => ({ costMicros: 50_000n, toolsUsd6: 0n }));
    const err = await q.quote({ spec: spec(tokens(20)), pricebookKey: "fanout.job", chain: "base" }).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteRefused);
    expect(err.reason).toBe("over_planner_budget");
  });

  test("the estimate scales the sample mean and adds retries, checking and fixed overhead", () => {
    const e = estimateFromSample([{ costMicros: 100n, toolsUsd6: 10n }, { costMicros: 201n, toolsUsd6: 21n }], 100, {
      retryBps: 1000,
      checkerBps: 5000,
      fixedMicros: 7n,
    });
    // mean 151 (rounded up) × 100 = 15_100; +10% = 16_610; +50% = 24_915; +7
    expect(e).toEqual({ sampleRows: 2, meanRowMicros: 151n, estCostMicros: 24_922n, estToolsUsd6: 1_600n });
  });

  test("measured tool spend sets the tools cap in the quote", async () => {
    const { q } = make(async () => ({ costMicros: 1_000n, toolsUsd6: 10_000n }));
    const r = await q.quote({ spec: spec(tokens(20)), pricebookKey: "fanout.job", chain: "base" });
    expect(r.quote.toolsCapUsd6).toBe(220_000n); // 20 × $0.01 × 1.1
  });
});

describe("waves and clocks", () => {
  test("600 items run as 3 waves of at most 247", () => {
    expect(planWaves(600)).toEqual([
      { wave: 0, from: 0, to: 246 },
      { wave: 1, from: 247, to: 493 },
      { wave: 2, from: 494, to: 599 },
    ]);
    expect(planWaves(247)).toHaveLength(1);
    expect(planWaves(248)).toHaveLength(2);
  });

  test("escrow expiry is 2h + 1h per extra wave, capped at 24h", () => {
    const h = 3_600_000;
    expect(expiryMs(1)).toBe(2 * h);
    expect(expiryMs(3)).toBe(4 * h);
    expect(expiryMs(50)).toBe(24 * h);
  });

  test("the job wall clock always ends before the escrow expires", () => {
    expect(jobWallClockMs(1)).toBe(30 * 60_000);
    expect(jobWallClockMs(3)).toBe(60 * 60_000);
    for (const w of [1, 2, 3, 9, 23]) expect(jobWallClockMs(w)).toBeLessThan(expiryMs(w));
  });
});
