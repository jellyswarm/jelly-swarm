import type { RowLeaf, Verdict } from "@jelly/checker";
import type { JobSpec, PriceLines, PricebookKey, Quote, RowResult, SettlementAmounts } from "@jelly/engine";
import type { Table } from "@jelly/merger";
import type { Seal } from "@jelly/receipts";
import type { AccountTier, ChainKey, FundingRoute, Lane, MeterBucket } from "@jelly/shared";
import type { Hex } from "viem";

/** Who is asking. Sign-in and sessions arrive in Phase 7; the service only needs this. */
export type Account = { id: string; tier: AccountTier };

export type StoredQuote = {
  id: string;
  accountId: string;
  chain: ChainKey;
  pricebookKey: PricebookKey;
  quote: Quote;
  signature: Hex;
  lines: PriceLines;
  spec: JobSpec;
  walletJob: boolean;
  tierForced: boolean;
  createdAtMs: number;
};

export type JobState =
  /** The escrow job exists and is waiting for money. */
  | "awaiting_payment"
  | "running"
  | "merging"
  /** Settled on-chain: passed rows are held for the dispute window, the rest refunded. */
  | "settled"
  /** Past the dispute window with no round open: the hold was released to the fee split. */
  | "finalized"
  /** Nothing passed, or the run failed: everything was refunded. */
  | "refunded"
  | "failed";

/** Where the keeper stands on auditing a settled job, once it has decided. */
export type AuditDecision = "audited" | "skipped";

export type StoredJob = {
  jobKey: Hex;
  jobId: bigint;
  quoteId: string;
  accountId: string;
  accountTier: AccountTier;
  chain: ChainKey;
  state: JobState;
  route: FundingRoute;
  lane: Lane;
  /** x402 payer, or the wallet that funds the job. */
  payer?: string;
  spec: JobSpec;
  lines: PriceLines;
  walletJob: boolean;
  createdAtMs: number;
  expiresAtSec: number;
  rows?: RowResult[];
  table?: Table;
  summary?: string | null;
  verdict?: { verdict: Verdict; signature: Hex; rows: RowLeaf[] };
  seal?: Seal;
  sealTx?: string;
  settleTx?: string;
  settledAtMs?: number;
  releaseAtSec?: number;
  amounts?: SettlementAmounts;
  /** Short, safe-to-show reason when state is "failed". */
  error?: string;

  // ── settlement-keeper (§6): audit sampling, finalize, volume (§8) ──
  /** Set once the keeper has decided whether to audit this job; undecided jobs are re-checked each tick. */
  auditDecision?: AuditDecision;
  auditRoundId?: bigint;
  finalizeTx?: string;
  finalizedAtMs?: number;
  /** real | external_small | incentive | internal | test, once classified for the volume meter. */
  meterBucket?: MeterBucket;
  volumeRecordedAtMs?: number;
  /** A job the studio ran for its own QA, never real or external_small volume. Not set by any public path. */
  testJob?: boolean;
  /** From the template that built this job, if any. §11.4: private and wallet-sweep jobs can never be shared beyond "private". */
  safetyClass?: "public" | "crypto-readonly" | "private";
};

export type JobEvent = { seq: number; ts: number; type: string; payload: unknown };

export type StoredDispute = {
  id: string;
  jobKey: Hex;
  accountId: string;
  rowIdx: number[];
  feeUsd6: bigint;
  evidence: string;
  createdAtMs: number;
};

export type ShareVisibility = "private" | "unlisted" | "public";

/** §11.4 a frozen snapshot: CSV + Markdown + manifest, taken at share time. Bumping a template later never changes this. */
export type ShareSnapshot = { csv: string; markdown: string; manifest: Record<string, unknown> };

export type StoredShare = {
  slug: string;
  jobKey: Hex;
  accountId: string;
  visibility: ShareVisibility;
  snapshot: ShareSnapshot;
  /** The template version the job was built from, if any; shown next to "Run this again" when it has moved on. */
  templateVersion?: number;
  createdAtMs: number;
};

export type ReferralState = "pending" | "paid" | "blocked";

export type StoredReferral = {
  id: string;
  refCode: string;
  referrerAccountId: string;
  refereeAccountId: string;
  state: ReferralState;
  blockReason?: string;
  qualifyingJobKey?: Hex;
  createdAtMs: number;
};

/** §10.3/§11.4 off-chain job credits: non-transferable, 90-day expiry, spendable on jobs only. */
export type CreditReason = "referral_referrer" | "referral_referee_signup" | "holder_allowance" | "restore" | "spend" | "expire";
export type StoredCreditEntry = { id: string; accountId: string; deltaUsd6: bigint; reason: CreditReason; jobKey?: Hex; createdAtMs: number; expiresAtMs?: number };

export type StoredApiKey = {
  keyId: string;
  /** sha-256 of the secret; the secret itself is shown once and never stored. */
  secretHash: string;
  accountId: string;
  owner: string;
  /** False until the owner signs the spend grant that lets the key spend. */
  active: boolean;
  createdAtMs: number;
};

/**
 * Persistence the service needs. `MemoryJobStore` is the Phase 5 stand-in;
 * the Postgres implementation over packages/db comes with the keeper in Phase 6.
 */
export interface JobStore {
  putQuote(q: StoredQuote): Promise<void>;
  getQuote(id: string): Promise<StoredQuote | undefined>;
  putJob(j: StoredJob): Promise<void>;
  getJob(jobKey: Hex): Promise<StoredJob | undefined>;
  /** The job already opened for a quote, if any: makes "run" safe to repeat. */
  getJobByQuote(quoteId: string): Promise<StoredJob | undefined>;
  updateJob(jobKey: Hex, patch: Partial<StoredJob>): Promise<StoredJob>;
  listJobs(accountId: string, limit: number): Promise<StoredJob[]>;
  /** Every job settled but not yet finalized: what the settlement-keeper has to act on each tick. */
  listAwaitingFinalize(): Promise<StoredJob[]>;
  /** Finalized or refunded jobs in `[sinceMs, untilMs)`, not yet recorded in the volume meter. */
  listForVolume(sinceMs: number, untilMs: number): Promise<StoredJob[]>;
  /** Every job created in `[sinceMs, untilMs)`, whatever its state. For admin tooling and `/stats`. */
  listAll(sinceMs: number, untilMs: number): Promise<StoredJob[]>;
  appendEvent(jobKey: Hex, type: string, payload: unknown): Promise<JobEvent>;
  eventsSince(jobKey: Hex, sinceSeq: number, limit: number): Promise<JobEvent[]>;
  putDispute(d: StoredDispute): Promise<void>;
  putApiKey(k: StoredApiKey): Promise<void>;
  getApiKeyByHash(secretHash: string): Promise<StoredApiKey | undefined>;

  putShare(s: StoredShare): Promise<void>;
  getShare(slug: string): Promise<StoredShare | undefined>;
  updateShare(slug: string, patch: Partial<StoredShare>): Promise<StoredShare>;
  listSharesForJob(jobKey: Hex): Promise<StoredShare[]>;

  /** A referral is keyed by referee: one referee can only ever have been referred once (§11.4 "There is no merge by email lookup" applies the same spirit here). */
  putReferral(r: StoredReferral): Promise<void>;
  getReferralByReferee(refereeAccountId: string): Promise<StoredReferral | undefined>;
  updateReferral(id: string, patch: Partial<StoredReferral>): Promise<StoredReferral>;
  /** Paid referrals credited to `referrerAccountId` since `sinceMs`, for the monthly cap. */
  countPaidReferralsSince(referrerAccountId: string, sinceMs: number): Promise<number>;
  getReferralCode(accountId: string): Promise<string | undefined>;
  putReferralCode(accountId: string, code: string): Promise<void>;
  getAccountForReferralCode(code: string): Promise<string | undefined>;

  addCredit(e: StoredCreditEntry): Promise<void>;
  /** Sum of unexpired deltas at `nowMs`; spends (negative deltas) are never excluded by expiry. */
  creditBalance(accountId: string, nowMs: number): Promise<bigint>;
}

export class MemoryJobStore implements JobStore {
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly jobs = new Map<Hex, StoredJob>();
  private readonly events = new Map<Hex, JobEvent[]>();
  readonly disputes: StoredDispute[] = [];
  private readonly apiKeys = new Map<string, StoredApiKey>();
  private readonly shares = new Map<string, StoredShare>();
  private readonly referralsByReferee = new Map<string, StoredReferral>();
  private readonly referralCodes = new Map<string, string>(); // accountId -> code
  private readonly referralCodeOwners = new Map<string, string>(); // code -> accountId
  private readonly credits: StoredCreditEntry[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  async putQuote(q: StoredQuote): Promise<void> {
    this.quotes.set(q.id, q);
  }

  async getQuote(id: string): Promise<StoredQuote | undefined> {
    return this.quotes.get(id);
  }

  async putJob(j: StoredJob): Promise<void> {
    this.jobs.set(j.jobKey, j);
  }

  async getJob(jobKey: Hex): Promise<StoredJob | undefined> {
    return this.jobs.get(jobKey);
  }

  async getJobByQuote(quoteId: string): Promise<StoredJob | undefined> {
    for (const j of this.jobs.values()) if (j.quoteId === quoteId) return j;
    return undefined;
  }

  async updateJob(jobKey: Hex, patch: Partial<StoredJob>): Promise<StoredJob> {
    const j = this.jobs.get(jobKey);
    if (!j) throw new Error(`unknown job ${jobKey}`);
    const next = { ...j, ...patch };
    this.jobs.set(jobKey, next);
    return next;
  }

  async listJobs(accountId: string, limit: number): Promise<StoredJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.accountId === accountId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit);
  }

  async listAwaitingFinalize(): Promise<StoredJob[]> {
    return [...this.jobs.values()].filter((j) => j.state === "settled");
  }

  async listForVolume(sinceMs: number, untilMs: number): Promise<StoredJob[]> {
    return [...this.jobs.values()].filter(
      (j) =>
        (j.state === "finalized" || j.state === "refunded") &&
        j.volumeRecordedAtMs === undefined &&
        j.createdAtMs >= sinceMs &&
        j.createdAtMs < untilMs,
    );
  }

  async listAll(sinceMs: number, untilMs: number): Promise<StoredJob[]> {
    return [...this.jobs.values()].filter((j) => j.createdAtMs >= sinceMs && j.createdAtMs < untilMs);
  }

  async appendEvent(jobKey: Hex, type: string, payload: unknown): Promise<JobEvent> {
    const list = this.events.get(jobKey) ?? [];
    const e = { seq: list.length + 1, ts: this.now(), type, payload };
    list.push(e);
    this.events.set(jobKey, list);
    return e;
  }

  async eventsSince(jobKey: Hex, sinceSeq: number, limit: number): Promise<JobEvent[]> {
    return (this.events.get(jobKey) ?? []).filter((e) => e.seq > sinceSeq).slice(0, limit);
  }

  async putDispute(d: StoredDispute): Promise<void> {
    this.disputes.push(d);
  }

  async putApiKey(k: StoredApiKey): Promise<void> {
    this.apiKeys.set(k.secretHash, k);
  }

  async getApiKeyByHash(secretHash: string): Promise<StoredApiKey | undefined> {
    return this.apiKeys.get(secretHash);
  }

  async putShare(s: StoredShare): Promise<void> {
    this.shares.set(s.slug, s);
  }

  async getShare(slug: string): Promise<StoredShare | undefined> {
    return this.shares.get(slug);
  }

  async updateShare(slug: string, patch: Partial<StoredShare>): Promise<StoredShare> {
    const s = this.shares.get(slug);
    if (!s) throw new Error(`unknown share ${slug}`);
    const next = { ...s, ...patch };
    this.shares.set(slug, next);
    return next;
  }

  async listSharesForJob(jobKey: Hex): Promise<StoredShare[]> {
    return [...this.shares.values()].filter((s) => s.jobKey === jobKey);
  }

  async putReferral(r: StoredReferral): Promise<void> {
    this.referralsByReferee.set(r.refereeAccountId, r);
  }

  async getReferralByReferee(refereeAccountId: string): Promise<StoredReferral | undefined> {
    return this.referralsByReferee.get(refereeAccountId);
  }

  async updateReferral(id: string, patch: Partial<StoredReferral>): Promise<StoredReferral> {
    for (const [key, r] of this.referralsByReferee) {
      if (r.id === id) {
        const next = { ...r, ...patch };
        this.referralsByReferee.set(key, next);
        return next;
      }
    }
    throw new Error(`unknown referral ${id}`);
  }

  async countPaidReferralsSince(referrerAccountId: string, sinceMs: number): Promise<number> {
    return [...this.referralsByReferee.values()].filter(
      (r) => r.referrerAccountId === referrerAccountId && r.state === "paid" && r.createdAtMs >= sinceMs,
    ).length;
  }

  async getReferralCode(accountId: string): Promise<string | undefined> {
    return this.referralCodes.get(accountId);
  }

  async putReferralCode(accountId: string, code: string): Promise<void> {
    this.referralCodes.set(accountId, code);
    this.referralCodeOwners.set(code, accountId);
  }

  async getAccountForReferralCode(code: string): Promise<string | undefined> {
    return this.referralCodeOwners.get(code);
  }

  async addCredit(e: StoredCreditEntry): Promise<void> {
    this.credits.push(e);
  }

  async creditBalance(accountId: string, nowMs: number): Promise<bigint> {
    return this.credits
      .filter((c) => c.accountId === accountId && (c.deltaUsd6 < 0n || c.expiresAtMs === undefined || c.expiresAtMs > nowMs))
      .reduce((sum, c) => sum + c.deltaUsd6, 0n);
  }
}
