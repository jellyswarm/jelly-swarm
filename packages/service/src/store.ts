import type { RowLeaf, Verdict } from "@jelly/checker";
import type { JobSpec, PriceLines, PricebookKey, Quote, RowResult, SettlementAmounts } from "@jelly/engine";
import type { Table } from "@jelly/merger";
import type { Seal } from "@jelly/receipts";
import type { AccountTier, ChainKey, FundingRoute, Lane } from "@jelly/shared";
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
  /** Nothing passed, or the run failed: everything was refunded. */
  | "refunded"
  | "failed";

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
  releaseAtSec?: number;
  amounts?: SettlementAmounts;
  /** Short, safe-to-show reason when state is "failed". */
  error?: string;
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
  appendEvent(jobKey: Hex, type: string, payload: unknown): Promise<JobEvent>;
  eventsSince(jobKey: Hex, sinceSeq: number, limit: number): Promise<JobEvent[]>;
  putDispute(d: StoredDispute): Promise<void>;
  putApiKey(k: StoredApiKey): Promise<void>;
  getApiKeyByHash(secretHash: string): Promise<StoredApiKey | undefined>;
}

export class MemoryJobStore implements JobStore {
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly jobs = new Map<Hex, StoredJob>();
  private readonly events = new Map<Hex, JobEvent[]>();
  readonly disputes: StoredDispute[] = [];
  private readonly apiKeys = new Map<string, StoredApiKey>();
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
}
