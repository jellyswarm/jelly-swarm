import { hashLabel } from "@jelly/receipts";
import {
  type ChainKey,
  DRY_RUN_SAMPLE_ITEMS,
  FEE_SPLIT_BPS,
  PLANNER_BUDGET_BPS,
  type Product,
  QUOTE_TTL_MS,
  type Tier,
  bps,
} from "@jelly/shared";
import { type Address, type Hex, verifyTypedData } from "viem";
import { type PriceLines, type PricebookKey, priceJob } from "./pricebook";
import { type JobSpec, specHash } from "./spec";
import { type AccountInspector, applyWalletRule } from "./wallet";

/** §3.2 The signed quote: Quote{specHash, units, unitUsd6, baseUsd6, toolsCapUsd6, tier, maxAgents, expiresAt, chain}. */
export type Quote = {
  specHash: Hex;
  units: number;
  unitUsd6: bigint;
  baseUsd6: bigint;
  toolsCapUsd6: bigint;
  tier: number;
  maxAgents: number;
  /** Unix seconds. */
  expiresAt: bigint;
  /** keccak(chain key), e.g. keccak("base"). */
  chain: Hex;
};

export const QUOTE_TYPES = {
  Quote: [
    { name: "specHash", type: "bytes32" },
    { name: "units", type: "uint32" },
    { name: "unitUsd6", type: "uint64" },
    { name: "baseUsd6", type: "uint64" },
    { name: "toolsCapUsd6", type: "uint64" },
    { name: "tier", type: "uint8" },
    { name: "maxAgents", type: "uint16" },
    { name: "expiresAt", type: "uint64" },
    { name: "chain", type: "bytes32" },
  ],
} as const;

export const TIER_ID: Record<Tier, number> = { open: 0, standard: 1, sealed: 2 };

/** One domain per product, so a quote for one product cannot be replayed on another. */
export const quoteDomain = (product: Product) =>
  ({ name: "JellySwarm Quotes", version: "1", salt: hashLabel(product) }) as const;

export interface QuoteSigner {
  address: Address;
  signTypedData(args: {
    domain: ReturnType<typeof quoteDomain>;
    types: typeof QUOTE_TYPES;
    primaryType: "Quote";
    message: Quote;
  }): Promise<Hex>;
}

export const quoteTotalUsd6 = (q: Quote): bigint => q.baseUsd6 + BigInt(q.units) * q.unitUsd6 + q.toolsCapUsd6;

export class QuoteRefused extends Error {
  constructor(
    readonly reason: "over_planner_budget" | "expired" | "bad_signature",
    message: string,
  ) {
    super(message);
    this.name = "QuoteRefused";
  }
}

export async function verifyQuote(
  product: Product,
  quote: Quote,
  signature: Hex,
  quoter: Address,
  nowMs: number,
): Promise<void> {
  const ok = await verifyTypedData({
    address: quoter,
    domain: quoteDomain(product),
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: quote,
    signature,
  }).catch(() => false);
  if (!ok) throw new QuoteRefused("bad_signature", "quote is not signed by the quoter key");
  if (BigInt(Math.floor(nowMs / 1000)) >= quote.expiresAt) {
    throw new QuoteRefused("expired", "quote has expired; request a new one");
  }
}

// ───────────────────────────── dry run ─────────────────────────────

/** What one sample row cost when the worker loop was actually run on it. */
export type SampleCost = { costMicros: bigint; toolsUsd6: bigint };

/**
 * How a measured sample is scaled to a whole job. These ratios are our
 * assumptions, not figures from the build doc; revisit them with real data.
 */
export type EstimateModel = {
  /** Extra worker spend for rows that are retried once. */
  retryBps: number;
  /** Checker spend as a share of worker spend. */
  checkerBps: number;
  /** Planner + merger spend per job. */
  fixedMicros: bigint;
};

export const DEFAULT_ESTIMATE: EstimateModel = { retryBps: 1500, checkerBps: 3000, fixedMicros: 20_000n };

export type CostEstimate = {
  sampleRows: number;
  meanRowMicros: bigint;
  estCostMicros: bigint;
  /** Raw (pre-markup) estimate of paid tool spend for the whole job. */
  estToolsUsd6: bigint;
};

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export function estimateFromSample(samples: readonly SampleCost[], pieces: number, model = DEFAULT_ESTIMATE): CostEstimate {
  if (samples.length === 0) throw new Error("dry run produced no samples");
  const n = BigInt(samples.length);
  const meanRowMicros = ceilDiv(
    samples.reduce((s, x) => s + x.costMicros, 0n),
    n,
  );
  const meanTools = ceilDiv(
    samples.reduce((s, x) => s + x.toolsUsd6, 0n),
    n,
  );
  const workers = meanRowMicros * BigInt(pieces);
  const withRetries = workers + bps(workers, model.retryBps);
  return {
    sampleRows: samples.length,
    meanRowMicros,
    estCostMicros: withRetries + bps(withRetries, model.checkerBps) + model.fixedMicros,
    estToolsUsd6: meanTools * BigInt(pieces),
  };
}

/**
 * §3.2: estimated cost must be at most 70% of (quote − fees). "Fees" here is
 * everything that does not go to worker operators (treasury, checker pay and
 * burn: 20% of rows + base). Tool spend is passed through and excluded.
 */
export function plannerBudgetMicros(lines: PriceLines): bigint {
  const gross = lines.rowsUsd6 + lines.baseUsd6;
  return bps(bps(gross, FEE_SPLIT_BPS.operators), PLANNER_BUDGET_BPS);
}

// ───────────────────────────── quoter ─────────────────────────────

export type QuoteRequest = {
  spec: JobSpec;
  /** A fixed entry, or a choice made once the wallet rule has run (a wallet list is priced as a wallet sweep). */
  pricebookKey: PricebookKey | ((walletJob: boolean) => PricebookKey);
  chain: ChainKey;
  discountBps?: number;
};

export type QuoteResult = {
  quote: Quote;
  signature: Hex;
  lines: PriceLines;
  /** The spec as quoted: the tier may have been forced to Sealed. */
  spec: JobSpec;
  specHash: Hex;
  walletJob: boolean;
  tierForced: boolean;
  estimate: CostEstimate;
};

export type QuoterDeps = {
  signer: QuoteSigner;
  inspector: AccountInspector;
  /**
   * Runs the worker loop on one sample item and reports what it cost. The
   * sample spend is ours; it is never billed.
   */
  runSample: (spec: JobSpec, itemIdx: number, walletJob: boolean) => Promise<SampleCost>;
  estimate?: EstimateModel;
  now?: () => number;
};

/** §3.2 Quote: wallet rule → dry run on a 5-item sample → price → budget check → EIP-712 signature. */
export class Quoter {
  constructor(private readonly deps: QuoterDeps) {}

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    const now = (this.deps.now ?? Date.now)();
    const ruled = await applyWalletRule(req.spec, this.deps.inspector, req.chain === "solana" ? "base" : req.chain);
    const spec = ruled.spec;
    const pieces = spec.items.length;

    const pricebookKey = typeof req.pricebookKey === "function" ? req.pricebookKey(ruled.walletJob) : req.pricebookKey;

    // Fail fast on tier or size before spending anything on the dry run.
    priceJob(pricebookKey, { tier: spec.tier, pieces, maxAgents: spec.maxAgents });

    const sampleCount = Math.min(DRY_RUN_SAMPLE_ITEMS, pieces);
    const samples = await Promise.all(
      Array.from({ length: sampleCount }, (_, i) => this.deps.runSample(spec, i, ruled.walletJob)),
    );
    const estimate = estimateFromSample(samples, pieces, this.deps.estimate);

    const lines = priceJob(pricebookKey, {
      tier: spec.tier,
      pieces,
      maxAgents: spec.maxAgents,
      toolsEstimateUsd6: estimate.estToolsUsd6,
      ...(req.discountBps !== undefined ? { discountBps: req.discountBps } : {}),
    });

    const budget = plannerBudgetMicros(lines);
    if (estimate.estCostMicros > budget) {
      throw new QuoteRefused(
        "over_planner_budget",
        `estimated cost ${estimate.estCostMicros} micros exceeds the planner budget ${budget} for this price`,
      );
    }

    const quote: Quote = {
      specHash: specHash(spec),
      units: lines.units,
      unitUsd6: lines.unitUsd6,
      baseUsd6: lines.baseUsd6,
      toolsCapUsd6: lines.toolsCapUsd6,
      tier: TIER_ID[spec.tier],
      maxAgents: lines.agents,
      expiresAt: BigInt(Math.floor((now + QUOTE_TTL_MS) / 1000)),
      chain: hashLabel(req.chain),
    };
    const signature = await this.deps.signer.signTypedData({
      domain: quoteDomain(spec.product),
      types: QUOTE_TYPES,
      primaryType: "Quote",
      message: quote,
    });
    return {
      quote,
      signature,
      lines,
      spec,
      specHash: quote.specHash,
      walletJob: ruled.walletJob,
      tierForced: ruled.tierForced,
      estimate,
    };
  }
}
