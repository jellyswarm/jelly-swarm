/**
 * Postgres schema (§8 of docs/source/core-backend.txt).
 *
 * Conventions:
 * - Money is bigint micro-dollars (`*_usd6`). No floats.
 * - Hashes, roots, addresses and tx ids are text (0x-hex on EVM, base58 on Solana).
 * - No email plaintext and no identity-document fields anywhere (§0.1);
 *   schema.test.ts enforces this.
 * - This file has no workspace imports so drizzle-kit can load it directly.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
const usd6 = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ───────────────────────── accounts & identity ─────────────────────────

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: createdAt(),
  /** free | paid | holder */
  tier: text("tier").notNull().default("free"),
  /** A ban blocks new jobs only. It never blocks withdrawals or refunds (§10.3). */
  bannedAt: ts("banned_at"),
});

export const passkeys = pgTable(
  "passkeys",
  {
    credentialId: bytea("credential_id").primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    publicKey: bytea("public_key").notNull(),
    signCount: bigint("sign_count", { mode: "number" }).notNull().default(0),
    transports: text("transports").array(),
    createdAt: createdAt(),
  },
  (t) => [index("passkeys_account_idx").on(t.accountId)],
);

/** Only HMAC(pepper, lowercase(email)) is stored (§10.1). */
export const emailLogins = pgTable("email_logins", {
  emailHmac: bytea("email_hmac").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  createdAt: createdAt(),
});

export const devices = pgTable("devices", {
  /** Signed device cookie id. */
  id: text("id").primaryKey(),
  /** Null until the account is created lazily on the first job. */
  accountId: uuid("account_id").references(() => accounts.id),
  /** Extra PoW difficulty bits from abuse feedback. */
  powPenaltyBits: integer("pow_penalty_bits").notNull().default(0),
  createdAt: createdAt(),
});

export const wallets = pgTable(
  "wallets",
  {
    address: text("address").notNull(),
    chain: text("chain").notNull(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    /** embedded | external | backup */
    kind: text("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.address, t.chain] }), index("wallets_account_idx").on(t.accountId)],
);

export const tgLinks = pgTable("tg_links", {
  tgUserId: bigint("tg_user_id", { mode: "bigint" }).primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  linkedAt: ts("linked_at").notNull().defaultNow(),
});

/** Wallet-bound API keys. Spending power comes from the on-chain SpendGrant, not from this row. */
export const apiKeys = pgTable(
  "api_keys",
  {
    keyId: text("key_id").primaryKey(),
    keyHash: bytea("key_hash").notNull(),
    // @jelly/service's own account-id space (may be "anon:<uuid>" or "key:<uuid>" for a caller
    // with no signed-in identity), not a row in `accounts` — see the comment on `quotes.accountId`.
    accountId: text("account_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    chain: text("chain").notNull(),
    /** Set once the owner has signed the SpendGrant that activates the key. */
    grantKeyId: text("grant_key_id"),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_keys_account_idx").on(t.accountId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id),
    deviceId: text("device_id").references(() => devices.id),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("sessions_account_idx").on(t.accountId)],
);

// ───────────────────────────────── jobs ─────────────────────────────────

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // @jelly/service's own account-id space, not a foreign key into `accounts`: a caller with
    // no signed-in identity gets a synthetic id (e.g. "anon:<uuid>") that never has an accounts row.
    accountId: text("account_id"),
    spec: jsonb("spec").notNull(),
    specHash: text("spec_hash").notNull(),
    product: text("product").notNull(),
    tier: text("tier").notNull(),
    chain: text("chain").notNull(),
    /** Item count (pieces). Items beyond 247 run in waves. */
    units: integer("units").notNull(),
    maxAgents: integer("max_agents").notNull(),
    unitUsd6: usd6("unit_usd6").notNull(),
    baseUsd6: usd6("base_usd6").notNull(),
    toolsCapUsd6: usd6("tools_cap_usd6").notNull(),
    /** Planner's estimated model cost from the dry run. */
    estCostUsd6: usd6("est_cost_usd6").notNull(),
    /** EIP-712 signature by the quoter key. */
    signature: text("signature").notNull(),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    /** Full StoredQuote (pricebookKey, the signed Quote, PriceLines, walletJob, tierForced), bigints as strings. */
    extra: jsonb("extra").notNull(),
  },
  (t) => [
    check("quotes_max_agents_cap", sql`${t.maxAgents} between 1 and 247`),
    check("quotes_units_positive", sql`${t.units} > 0`),
    check(
      "quotes_amounts_nonneg",
      sql`${t.unitUsd6} >= 0 and ${t.baseUsd6} >= 0 and ${t.toolsCapUsd6} >= 0 and ${t.estCostUsd6} >= 0`,
    ),
    index("quotes_account_idx").on(t.accountId),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    /** keccak(chainId, JellyJob, jobId) on EVM, or the Solana job key. */
    jobKey: text("job_key").primaryKey(),
    chain: text("chain").notNull(),
    onchainJobId: text("onchain_job_id"),
    quoteId: uuid("quote_id").notNull().references(() => quotes.id),
    // @jelly/service's own account-id space; see the comment on quotes.accountId above.
    accountId: text("account_id"),
    product: text("product").notNull(),
    tier: text("tier").notNull(),
    lane: text("lane").notNull(),
    /** quoted | funded | running | merging | sealed | settled | finalized | refunded | expired | cancelled */
    state: text("state").notNull().default("quoted"),
    /** wallet | vault | x402 | free | credits | acp */
    fundingRoute: text("funding_route"),
    funder: text("funder"),
    /** Fixed at fund; every refund for this job goes here. */
    refundTo: text("refund_to"),
    /** True if any item is a wallet address. Forces Sealed and TEE-only hosts. */
    walletJob: boolean("wallet_job").notNull().default(false),
    budgetUsd6: usd6("budget_usd6").notNull(),
    rowCount: integer("row_count").notNull(),
    passedCount: integer("passed_count"),
    toolsUsd6: usd6("tools_usd6"),
    /** Actual model spend, for our ledger. The client never pays more than the quote (§0.4). */
    costUsd6: usd6("cost_usd6").notNull().default(sql`0`),
    receiptsRoot: text("receipts_root"),
    receiptsCount: integer("receipts_count"),
    receiptsHead: text("receipts_head"),
    rowsRoot: text("rows_root"),
    verdictSig: text("verdict_sig"),
    fundTx: text("fund_tx"),
    sealTx: text("seal_tx"),
    settleTx: text("settle_tx"),
    finalizeTx: text("finalize_tx"),
    /** real | external_small | incentive | internal | test */
    meterBucket: text("meter_bucket"),
    createdAt: createdAt(),
    fundedAt: ts("funded_at"),
    settledAt: ts("settled_at"),
    /** End of the dispute window; finalize is allowed after this. */
    releaseAt: ts("release_at"),
    finalizedAt: ts("finalized_at"),
    /** After this, anyone may claim a full refund if the job never settled. */
    expiredAt: ts("expired_at"),
    /** Null until listForVolume has recorded this job in the volume meter. */
    volumeRecordedAt: ts("volume_recorded_at"),
    /** Full StoredJob (spec, lines, rows, table, summary, verdict, seal, amounts, ...), bigints as strings. */
    job: jsonb("job").notNull(),
  },
  (t) => [
    check("jobs_passed_le_rows", sql`${t.passedCount} is null or ${t.passedCount} between 0 and ${t.rowCount}`),
    index("jobs_account_idx").on(t.accountId, t.createdAt),
    index("jobs_state_idx").on(t.state),
    uniqueIndex("jobs_chain_onchain_idx").on(t.chain, t.onchainJobId),
  ],
);

export const rows = pgTable(
  "rows",
  {
    jobKey: text("job_key").notNull().references(() => jobs.jobKey),
    rowIdx: integer("row_idx").notNull(),
    item: jsonb("item").notNull(),
    /** queued | scouting | working | checking | retrying | passed | refunded */
    state: text("state").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    cells: jsonb("cells"),
    /** Operator credited if the row passes. */
    operatorId: bigint("operator_id", { mode: "bigint" }),
    host: text("host"),
    failReason: text("fail_reason"),
    /** Hash over this row's receipt leaves; part of the rows-root leaf (§4). */
    rowReceiptsHash: text("row_receipts_hash"),
    toolsUsd6: usd6("tools_usd6").notNull().default(sql`0`),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.jobKey, t.rowIdx] }),
    check("rows_idx_nonneg", sql`${t.rowIdx} >= 0`),
    index("rows_job_state_idx").on(t.jobKey, t.state),
  ],
);

/** One receipt per model or paid-tool call (§4). Append-only; step_idx is strictly sequential per job. */
export const receipts = pgTable(
  "receipts",
  {
    jobKey: text("job_key").notNull().references(() => jobs.jobKey),
    stepIdx: integer("step_idx").notNull(),
    agentId: integer("agent_id").notNull(),
    role: smallint("role").notNull(),
    /** Null when the call is not tied to a row (0xFFFFFFFF on-chain). */
    rowIdx: integer("row_idx"),
    prevHash: text("prev_hash").notNull(),
    inputHash: text("input_hash").notNull(),
    toolCallsHash: text("tool_calls_hash").notNull(),
    modelId: text("model_id").notNull(),
    host: text("host").notNull(),
    costMicros: bigint("cost_micros", { mode: "bigint" }).notNull(),
    outputHash: text("output_hash").notNull(),
    attestationRef: text("attestation_ref").notNull(),
    /** hashTypedData(receipt). */
    leaf: text("leaf").notNull(),
    signature: text("signature").notNull(),
    /** Community nodes also sign outputHash. */
    nodeSignature: text("node_signature"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.jobKey, t.stepIdx] }),
    check("receipts_step_nonneg", sql`${t.stepIdx} >= 0`),
    index("receipts_job_row_idx").on(t.jobKey, t.rowIdx),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    jobKey: text("job_key").notNull(),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    ts: ts("ts").notNull().defaultNow(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    /** True if the event may go out on the public channel. */
    isPublic: boolean("is_public").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.jobKey, t.seq] })],
);

export const disputes = pgTable(
  "disputes",
  {
    /** Caller-supplied (the service layer's own randomUUID()), not DB-generated. */
    id: uuid("id").primaryKey(),
    jobKey: text("job_key").notNull().references(() => jobs.jobKey),
    // @jelly/service's own account-id space; see the comment on quotes.accountId above.
    accountId: text("account_id").notNull(),
    rowIdx: integer("row_idx").array().notNull(),
    feeUsd6: usd6("fee_usd6").notNull(),
    /** client | audit */
    kind: text("kind").notNull(),
    /** open | upheld | reversed */
    state: text("state").notNull().default("open"),
    evidence: jsonb("evidence"),
    refundBps: integer("refund_bps").array(),
    tx: text("tx"),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    check("disputes_max_rows", sql`cardinality(${t.rowIdx}) between 1 and 25`),
    index("disputes_job_idx").on(t.jobKey),
  ],
);

// ──────────────────────────────── retail ────────────────────────────────

export const templates = pgTable("templates", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  product: text("product").notNull(),
  title: text("title").notNull(),
  /** active | hidden */
  status: text("status").notNull().default("active"),
  safetyClass: text("safety_class").notNull(),
  currentVersion: integer("current_version").notNull().default(1),
});

export const templateVersions = pgTable(
  "template_versions",
  {
    templateId: text("template_id").notNull().references(() => templates.id),
    version: integer("version").notNull(),
    specTemplate: jsonb("spec_template").notNull(),
    pricebookKey: text("pricebook_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.version] })],
);

export const shareLinks = pgTable(
  "share_links",
  {
    slug: text("slug").primaryKey(),
    jobKey: text("job_key").notNull().references(() => jobs.jobKey),
    // @jelly/service's own account-id space; see the comment on quotes.accountId above.
    accountId: text("account_id").notNull(),
    /** private | unlisted | public */
    visibility: text("visibility").notNull().default("private"),
    /** Frozen snapshot: CSV + Markdown + manifest. */
    snapshot: jsonb("snapshot").notNull(),
    templateVersion: integer("template_version"),
    createdAt: createdAt(),
  },
  (t) => [index("share_links_job_idx").on(t.jobKey)],
);

/** One stable code per account (§11.4). Looked up both ways: by owner and by code. */
export const referralCodes = pgTable("referral_codes", {
  // @jelly/service's own account-id space; see the comment on quotes.accountId above.
  accountId: text("account_id").primaryKey(),
  code: text("code").notNull().unique(),
  createdAt: createdAt(),
});

export const referrals = pgTable(
  "referrals",
  {
    /** Caller-supplied (the service layer's own randomUUID()), not DB-generated. */
    id: uuid("id").primaryKey(),
    refCode: text("ref_code").notNull(),
    // @jelly/service's own account-id space; see the comment on quotes.accountId above.
    referrer: text("referrer").notNull(),
    referee: text("referee").notNull(),
    /** pending | paid | blocked */
    state: text("state").notNull().default("pending"),
    blockReason: text("block_reason"),
    /** The referee's first finalized external paid job. */
    qualifyingJobKey: text("qualifying_job_key"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("referrals_referee_idx").on(t.referee),
    index("referrals_referrer_idx").on(t.referrer, t.createdAt),
    check("referrals_not_self", sql`${t.referrer} <> ${t.referee}`),
  ],
);

/** Off-chain, non-transferable job credits. Balance = sum of unexpired deltas. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    // @jelly/service's own account-id space; see the comment on quotes.accountId above.
    accountId: text("account_id").notNull(),
    deltaUsd6: usd6("delta_usd6").notNull(),
    /** referral | signup | holder_allowance | restore | spend | expire */
    reason: text("reason").notNull(),
    jobKey: text("job_key"),
    createdAt: createdAt(),
    expiresAt: ts("expires_at"),
  },
  (t) => [index("credit_ledger_account_idx").on(t.accountId, t.createdAt)],
);

export const freeGrants = pgTable(
  "free_grants",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id),
    deviceId: text("device_id").notNull().references(() => devices.id),
    /** /24 for IPv4, /48 for IPv6. Never the full address. */
    ipPrefix: text("ip_prefix").notNull(),
    asn: integer("asn"),
    jobKey: text("job_key"),
    quoteUsd6: usd6("quote_usd6").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("free_grants_device_idx").on(t.deviceId),
    index("free_grants_prefix_idx").on(t.ipPrefix, t.createdAt),
  ],
);

// ───────────────────── compute, money and the meter ─────────────────────

export const operators = pgTable("operators", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  payout: text("payout").notNull(),
  /** tee | fingerprint | studio */
  route: text("route").notNull(),
  endpointHash: text("endpoint_hash"),
  attestHash: text("attest_hash"),
  /** True for our own operator ids; /stats discloses their share. */
  isStudio: boolean("is_studio").notNull().default(false),
  /** pending | active | exiting | removed */
  state: text("state").notNull().default("pending"),
  strikes: integer("strikes").notNull().default(0),
  passingCanaries: integer("passing_canaries").notNull().default(0),
  createdAt: createdAt(),
  exitRequestedAt: ts("exit_requested_at"),
});

export const nodeAudits = pgTable(
  "node_audits",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    operatorId: bigint("operator_id", { mode: "bigint" }).notNull().references(() => operators.id),
    callLeaf: text("call_leaf"),
    /** canary | reexecute | attest */
    kind: text("kind").notNull(),
    passed: boolean("passed").notNull(),
    score: jsonb("score"),
    evidenceHash: text("evidence_hash"),
    slashTx: text("slash_tx"),
    createdAt: createdAt(),
  },
  (t) => [index("node_audits_operator_idx").on(t.operatorId, t.createdAt)],
);

export const payoutEpochs = pgTable(
  "payout_epochs",
  {
    epoch: integer("epoch").notNull(),
    chain: text("chain").notNull(),
    root: text("root").notNull(),
    totalUsd6: usd6("total_usd6").notNull(),
    tx: text("tx"),
    /** Per-operator amounts and proofs, for claims. */
    leaves: jsonb("leaves").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.epoch, t.chain] })],
);

/** Every burn names the jobs that funded it (§0.5). */
export const burns = pgTable("burns", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  product: text("product").notNull(),
  chain: text("chain").notNull(),
  jobKeysRoot: text("job_keys_root").notNull(),
  jobKeys: text("job_keys").array().notNull(),
  /** burn | sweep_to_treasury | bridge_out */
  kind: text("kind").notNull(),
  stableInUsd6: usd6("stable_in_usd6").notNull(),
  tokenBurned: text("token_burned"),
  reason: text("reason"),
  tx: text("tx"),
  createdAt: createdAt(),
});

export const meterPosts = pgTable(
  "meter_posts",
  {
    day: date("day").notNull(),
    product: text("product").notNull(),
    chain: text("chain").notNull(),
    realUsd6: usd6("real_usd6").notNull(),
    externalSmallUsd6: usd6("external_small_usd6").notNull(),
    incentiveUsd6: usd6("incentive_usd6").notNull(),
    internalUsd6: usd6("internal_usd6").notNull(),
    testUsd6: usd6("test_usd6").notNull(),
    jobsRoot: text("jobs_root").notNull(),
    tx: text("tx"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.day, t.product, t.chain] })],
);

/** Wallets we control or fund. The volume classifier treats anything within 3 hops as internal. */
export const studioWallets = pgTable(
  "studio_wallets",
  {
    address: text("address").notNull(),
    chain: text("chain").notNull(),
    /** treasury | operator | free_tier | credits | relayer | keeper | test */
    purpose: text("purpose").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.address, t.chain] })],
);

/** One classified row per finalized job. */
export const volumeLedger = pgTable(
  "volume_ledger",
  {
    jobKey: text("job_key").primaryKey().references(() => jobs.jobKey),
    day: date("day").notNull(),
    product: text("product").notNull(),
    chain: text("chain").notNull(),
    funder: text("funder").notNull(),
    grossUsd6: usd6("gross_usd6").notNull(),
    bucket: text("bucket").notNull(),
    /** Why it landed in this bucket (e.g. the funding path that linked it to us). */
    evidence: jsonb("evidence"),
    createdAt: createdAt(),
  },
  (t) => [index("volume_ledger_day_idx").on(t.day, t.product, t.chain)],
);

export const x402Payments = pgTable(
  "x402_payments",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    network: text("network").notNull(),
    payer: text("payer").notNull(),
    payTo: text("pay_to").notNull(),
    amountUsd6: usd6("amount_usd6").notNull(),
    /** Payment nonce; unique per network so a replay is rejected. */
    nonce: text("nonce").notNull(),
    /** job | topup */
    mode: text("mode").notNull(),
    jobKey: text("job_key"),
    /** verified | settled | swept | refunded */
    state: text("state").notNull(),
    tx: text("tx"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("x402_nonce_idx").on(t.network, t.nonce), index("x402_job_idx").on(t.jobKey)],
);
