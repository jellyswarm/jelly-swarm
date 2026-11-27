import { z } from "zod";

/**
 * Engine-wide constants. Section references (§) point at
 * docs/source/core-backend.txt, the build doc these values come from.
 */

/** §0.4 Hard cap on concurrent workers per job. Never raise it. */
export const MAX_AGENTS = 247;

/** §0.5 Fee split in basis points. Fixed; must sum to 10_000. */
export const FEE_SPLIT_BPS = {
  operators: 8000,
  treasury: 1000,
  checker: 500,
  burn: 500,
} as const;

export const BPS_DENOMINATOR = 10_000;

/** §3.2 A signed quote is valid for 10 minutes. */
export const QUOTE_TTL_MS = 10 * 60 * 1000;

/** §3.2 Dry-run sample size, and the share of (quote - fees) estimated cost may use. */
export const DRY_RUN_SAMPLE_ITEMS = 5;
export const PLANNER_BUDGET_BPS = 7000;

/** §3.3 Escrow expiry: 2h + 1h per extra wave, at most 24h. */
export const EXPIRY_BASE_MS = 2 * 60 * 60 * 1000;
export const EXPIRY_PER_EXTRA_WAVE_MS = 60 * 60 * 1000;
export const EXPIRY_MAX_MS = 24 * 60 * 60 * 1000;

/** §13 Job wall clock: 30 min + 15 min per extra wave, hard 24h. */
export const JOB_WALL_BASE_MS = 30 * 60 * 1000;
export const JOB_WALL_PER_EXTRA_WAVE_MS = 15 * 60 * 1000;
export const JOB_WALL_MAX_MS = 24 * 60 * 60 * 1000;

/** §3.3 / §13 Per-row loop caps. */
export const ROW_CAPS = {
  maxToolCalls: 12,
  maxLlmTurns: 4,
  wallClockMs: 6 * 60 * 1000,
  /** A failed row gets one retry, then is refunded. */
  maxAttempts: 2,
} as const;

/** §13 Loop detectors. */
export const LOOP_CAPS = {
  maxIdenticalInputsPerJob: 2,
  maxRepeatedOutputsPerRow: 3,
} as const;

/** §3.3 Settlement: dispute window, audit sampling, dispute batching. */
export const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AUDIT_SAMPLE_BPS = 500;
export const AUDIT_ALWAYS_AT_USD6 = 50_000_000n;
export const AUDIT_PANEL_SIZE = 3;
export const DISPUTE_MAX_ROWS = 25;
export const DISPUTE_MIN_FEE_USD6 = 500_000n;
export const DISPUTE_FEE_BPS = 100;

/** §3.3 Refund curve for reversed rows, by dispute step (bps of the row unit). */
export const REFUND_CURVE_BPS = [10_000, 7_500, 3_500, 0] as const;

/** §3.3 A reversed pass slashes the verdict signer's bond by 10%. */
export const CHECKER_SLASH_BPS = 1000;

/** §3.4 A row passes only if at least 80% of its sourced cells pass. */
export const ROW_PASS_SOURCED_CELLS_BPS = 8000;
/** §3.4 Numeric cells must be within 0.5% of the source. */
export const NUMERIC_TOLERANCE_BPS = 50;

/** §3.2 Tool spend is billed at cost plus 10%, up to the quoted cap. */
export const TOOLS_MARKUP_BPS = 1000;

/** §2.3 Heartbeat downgrade thresholds, as bps of the remaining quote. */
export const HEARTBEAT_BPS = {
  /** At or above: normal. */
  normal: 5000,
  /** At or above (and below `normal`): drop one model class, halve the wave. */
  downgrade: 2000,
  /** Below `downgrade` and above 0: no new rows. At 0: stop. */
} as const;

/** §2.3 Router health filter and fallback. */
export const ROUTER = {
  maxErrorRateBps: 500,
  errorWindowMs: 60_000,
  maxFallbackHosts: 2,
} as const;

/** §5 Community compute. */
export const NODE_AUDIT = {
  reexecuteBps: 500,
  canaryBps: 200,
  admissionCanaries: 50,
  slashBps: 1000,
  strikesToRemove: 3,
  exitCooldownMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** §10.3 Free tier. */
export const FREE_TIER = {
  maxQuoteUsd6: 550_000n,
  maxWallets: 3,
  perDeviceEver: 1,
  perIpPrefixPerDay: 3,
  perAsnPerDay: 10,
  powChallengeTtlMs: 2 * 60 * 1000,
} as const;

/** §10.3 / §11.4 Credits and referrals. */
export const CREDITS = {
  expiryMs: 90 * 24 * 60 * 60 * 1000,
  referrerUsd6: 1_000_000n,
  refereeUsd6: 500_000n,
  referralCapPerMonth: 50,
  minPaidJobUsd6: 1_000_000n,
} as const;

/** §8 Volume classifier. */
export const VOLUME = {
  realMinUsd6: 1_000_000n,
  fundingHops: 3,
  fundingLookbackMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export const Product = z.enum(["fanout", "trawl", "picket"]);
export type Product = z.infer<typeof Product>;

export const Tier = z.enum(["open", "standard", "sealed"]);
export type Tier = z.infer<typeof Tier>;

/** §2.1 Engine roles. `settler` is the settlement keeper, not a model. */
export const Role = z.enum(["intake", "planner", "worker", "checker", "merger", "spotter"]);
export type Role = z.infer<typeof Role>;

/** §4 Role ids as written into receipts (uint8). */
export const ROLE_ID: Record<Role, number> = {
  intake: 0,
  planner: 1,
  worker: 2,
  checker: 3,
  merger: 4,
  spotter: 5,
};

export const Lane = z.enum(["priority", "paid", "free", "deferred"]);
export type Lane = z.infer<typeof Lane>;

/** §12.3 BullMQ priorities (lower runs first). */
export const LANE_PRIORITY: Record<Lane, number> = {
  priority: 1,
  paid: 2,
  free: 5,
  deferred: 10,
};

/** §12.3 Concurrent jobs per account. */
export const ACCOUNT_CONCURRENCY = { free: 1, paid: 5, holder: 10 } as const;
export const AccountTier = z.enum(["free", "paid", "holder"]);
export type AccountTier = z.infer<typeof AccountTier>;

/** §3.3 The five funding routes. */
export const FundingRoute = z.enum(["wallet", "vault", "x402", "free", "credits", "acp"]);
export type FundingRoute = z.infer<typeof FundingRoute>;

/** §8 Volume buckets. Burn eligibility is `real` or `external_small`. */
export const MeterBucket = z.enum(["real", "external_small", "incentive", "internal", "test"]);
export type MeterBucket = z.infer<typeof MeterBucket>;
export const isBurnEligible = (b: MeterBucket): boolean => b === "real" || b === "external_small";

/** §11.2 Live tile states. */
export const TileState = z.enum(["scouting", "working", "checking", "passed", "retrying", "refunded"]);
export type TileState = z.infer<typeof TileState>;

/** Number of waves needed for `pieces` items (§3.2: 600 items run as 3 waves). */
export const wavesFor = (pieces: number): number => Math.max(1, Math.ceil(pieces / MAX_AGENTS));
