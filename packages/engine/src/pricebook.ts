import { MAX_AGENTS, type Product, TOOLS_MARKUP_BPS, type Tier, bps, usd6, wavesFor } from "@jelly/shared";

/**
 * §3.2 pricebook. Every amount is integer micro-dollars.
 *
 * A job is priced as `base + pieces × unit + toolsCap`. Each row is its own
 * payment slot of `unit`, so a failed row refunds exactly its unit. `base` is
 * charged only if at least one row passes.
 */
export type PerUnitEntry = {
  kind: "per_unit";
  product: Product;
  baseUsd6: bigint;
  /** Tiers not listed are not offered for this entry. */
  tiers: Partial<Record<Tier, { unitUsd6: bigint; minUsd6?: bigint }>>;
};

export type FlatEntry = {
  kind: "flat";
  product: Product;
  tiers: readonly Tier[];
  /** Price bands by item count, ascending. A job larger than the last band is refused. */
  bands: readonly { upTo: number; usd6: bigint }[];
};

export type PriceEntry = PerUnitEntry | FlatEntry;

export const PRICEBOOK = {
  /** $0.25 per job + $0.005 / $0.015 / $0.04 per agent. */
  "fanout.job": {
    kind: "per_unit",
    product: "fanout",
    baseUsd6: usd6("0.25"),
    tiers: {
      open: { unitUsd6: usd6("0.005") },
      standard: { unitUsd6: usd6("0.015") },
      sealed: { unitUsd6: usd6("0.04") },
    },
  },
  /** Token sweep: $0.05 per token (min $2) on Standard, $0.15 (min $5) on Sealed. */
  "trawl.token": {
    kind: "per_unit",
    product: "trawl",
    baseUsd6: 0n,
    tiers: {
      standard: { unitUsd6: usd6("0.05"), minUsd6: usd6("2") },
      sealed: { unitUsd6: usd6("0.15"), minUsd6: usd6("5") },
    },
  },
  /** Wallet sweep: $0.50 per wallet (min $2). Always Sealed. */
  "trawl.wallet": {
    kind: "per_unit",
    product: "trawl",
    baseUsd6: 0n,
    tiers: { sealed: { unitUsd6: usd6("0.50"), minUsd6: usd6("2") } },
  },
  /** Research report: flat $9. */
  "trawl.report": {
    kind: "flat",
    product: "trawl",
    tiers: ["standard", "sealed"],
    bands: [{ upTo: MAX_AGENTS, usd6: usd6("9") }],
  },
  /** Everyday list: flat $3 up to 50 items, $9 up to 247. */
  "trawl.everyday": {
    kind: "flat",
    product: "trawl",
    tiers: ["standard", "sealed"],
    bands: [
      { upTo: 50, usd6: usd6("3") },
      { upTo: MAX_AGENTS, usd6: usd6("9") },
    ],
  },
} as const satisfies Record<string, PriceEntry>;

export type PricebookKey = keyof typeof PRICEBOOK;

/** Token holders get up to 20% off that product's quotes. */
export const MAX_DISCOUNT_BPS = 2000;

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

export type PriceLines = {
  pricebookKey: PricebookKey;
  tier: Tier;
  /** Item count. Each is one payment slot. */
  units: number;
  /** Concurrency for this job: min(units, maxAgents), never above 247. */
  agents: number;
  waves: number;
  unitUsd6: bigint;
  baseUsd6: bigint;
  /** units × unit. */
  rowsUsd6: bigint;
  /** Ceiling for paid data and tool calls at cost + 10%; billed at actual. */
  toolsCapUsd6: bigint;
  totalUsd6: bigint;
};

export type PriceInput = {
  tier: Tier;
  pieces: number;
  maxAgents: number;
  /** Estimated raw cost of paid data and tool calls, before the 10% markup. */
  toolsEstimateUsd6?: bigint;
  discountBps?: number;
};

export function priceJob(key: PricebookKey, input: PriceInput): PriceLines {
  const entry: PriceEntry = PRICEBOOK[key];
  const { tier, pieces } = input;
  if (!Number.isInteger(pieces) || pieces < 1) throw new PricingError("a job needs at least one item");
  if (!Number.isInteger(input.maxAgents) || input.maxAgents < 1 || input.maxAgents > MAX_AGENTS) {
    throw new PricingError(`maxAgents must be between 1 and ${MAX_AGENTS}`);
  }
  const discountBps = input.discountBps ?? 0;
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > MAX_DISCOUNT_BPS) {
    throw new PricingError(`discount must be between 0 and ${MAX_DISCOUNT_BPS} bps`);
  }
  const toolsEstimate = input.toolsEstimateUsd6 ?? 0n;
  if (toolsEstimate < 0n) throw new PricingError("tools estimate must not be negative");

  let unitUsd6: bigint;
  let baseUsd6: bigint;
  const units = BigInt(pieces);

  if (entry.kind === "per_unit") {
    const t = entry.tiers[tier];
    if (!t) throw new PricingError(`${key} is not offered on the ${tier} tier`);
    unitUsd6 = t.unitUsd6;
    // Minimum: base = max(product.base, min − units × unit).
    const shortfall = (t.minUsd6 ?? 0n) - units * unitUsd6;
    baseUsd6 = shortfall > entry.baseUsd6 ? shortfall : entry.baseUsd6;
  } else {
    if (!entry.tiers.includes(tier)) throw new PricingError(`${key} is not offered on the ${tier} tier`);
    const band = entry.bands.find((b) => pieces <= b.upTo);
    if (!band) throw new PricingError(`${key} takes at most ${entry.bands.at(-1)!.upTo} items`);
    // Flat prices become equal per-row slots so pay-on-pass still applies.
    // The division remainder sits in the base, so the total is exactly the flat price.
    unitUsd6 = band.usd6 / units;
    baseUsd6 = band.usd6 - unitUsd6 * units;
  }

  if (discountBps > 0) {
    unitUsd6 -= bps(unitUsd6, discountBps);
    baseUsd6 -= bps(baseUsd6, discountBps);
  }

  const rowsUsd6 = units * unitUsd6;
  // Cost plus 10%, rounded up.
  const toolsCapUsd6 = (toolsEstimate * BigInt(10_000 + TOOLS_MARKUP_BPS) + 9_999n) / 10_000n;

  return {
    pricebookKey: key,
    tier,
    units: pieces,
    agents: Math.min(pieces, input.maxAgents, MAX_AGENTS),
    waves: wavesFor(pieces),
    unitUsd6,
    baseUsd6,
    rowsUsd6,
    toolsCapUsd6,
    totalUsd6: baseUsd6 + rowsUsd6 + toolsCapUsd6,
  };
}

export type SettlementAmounts = {
  /** What the client pays for rows and base; goes to the fee split after the dispute window. */
  grossUsd6: bigint;
  /** Tool spend billed at actual cost + 10%, capped at toolsCap. */
  toolsBilledUsd6: bigint;
  /** Returned to the client at settlement. */
  refundUsd6: bigint;
};

/**
 * §3.3 step 7. Refund = (rowCount − passed) × unit + (toolsCap − tools),
 * plus the base if nothing passed. `toolsSpentUsd6` is the raw cost of paid
 * tools on passed rows; tool spend on failed rows is absorbed by us.
 */
export function settlementAmounts(lines: PriceLines, passedCount: number, toolsSpentUsd6: bigint): SettlementAmounts {
  if (!Number.isInteger(passedCount) || passedCount < 0 || passedCount > lines.units) {
    throw new PricingError(`passed count out of range: ${passedCount}`);
  }
  if (toolsSpentUsd6 < 0n) throw new PricingError("tool spend must not be negative");
  const withMarkup = (toolsSpentUsd6 * BigInt(10_000 + TOOLS_MARKUP_BPS) + 9_999n) / 10_000n;
  const toolsBilledUsd6 = passedCount === 0 ? 0n : withMarkup > lines.toolsCapUsd6 ? lines.toolsCapUsd6 : withMarkup;
  const grossUsd6 = passedCount === 0 ? 0n : BigInt(passedCount) * lines.unitUsd6 + lines.baseUsd6;
  return { grossUsd6, toolsBilledUsd6, refundUsd6: lines.totalUsd6 - grossUsd6 - toolsBilledUsd6 };
}
