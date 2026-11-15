import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type VerdictSigner, buildVerdict, signVerdict } from "@jelly/checker";
import {
  Column,
  type Engine,
  type EngineEvent,
  type EngineJob,
  JobSpec,
  type PricebookKey,
  PricingError,
  QuoteRefused,
  type Quoter,
  expiryMs,
  normalizeItems,
  settlementAmounts,
  verifyQuote,
} from "@jelly/engine";
import { type EventBus, TileCoalescer } from "@jelly/live";
import { type Merger, toCsv, toJson, toMarkdown } from "@jelly/merger";
import { type ReceiptChain, merkleProof } from "@jelly/receipts";
import { ChainKey, DISPUTE_FEE_BPS, DISPUTE_MAX_ROWS, DISPUTE_MIN_FEE_USD6, MAX_AGENTS, Product, Tier, formatUsd6 } from "@jelly/shared";
import { type Address, type Hex, isAddress } from "viem";
import { z } from "zod";
import { COPY } from "./copy";
import type { Escrow, SignedGrant, UnsignedCall } from "./escrow";
import type { Account, JobEvent, JobStore, StoredJob, StoredQuote } from "./store";

export type ServiceErrorCode = "not_found" | "invalid" | "expired" | "not_ready" | "payment_required" | "forbidden";

/** An error whose message is safe to show to the caller. Anything else is an internal fault. */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const QuoteInput = z.object({
  product: Product.default("fanout"),
  task: z.string().min(1).max(4000),
  items: z.array(z.string().max(2000)).max(2000).optional(),
  columns: z.array(Column).max(32).optional(),
  tier: Tier.default("standard"),
  maxAgents: z.number().int().min(1).max(MAX_AGENTS).default(MAX_AGENTS),
  templateId: z.string().max(100).optional(),
  chain: ChainKey.default("base"),
  premiumPlanner: z.boolean().optional(),
});
export type QuoteInput = z.input<typeof QuoteInput>;

export type QuoteView = {
  quoteId: string;
  agents: number;
  of: typeof MAX_AGENTS;
  priceUsd: string;
  lines: { base: string; rows: string; toolsCap: string };
  tier: Tier;
  /** True if the tier was raised to Sealed because the list contains wallet addresses. */
  tierForced: boolean;
  waves: number;
  chain: ChainKey;
  expiresAt: string;
};

export type JobView = {
  jobKey: Hex;
  state: StoredJob["state"];
  agents: number;
  of: typeof MAX_AGENTS;
  quoteUsd: string;
  rows: { total: number; passed: number; refunded: number };
  paidUsd?: string;
  refundedUsd?: string;
  error?: string;
};

export type StatusView = JobView & {
  /** Rows by live state: scouting, working, checking, passed, retrying, refunded. */
  tiles: Record<string, number>;
  spentUsd?: string;
  events: JobEvent[];
  /** Pass as `sinceSeq` next time to get only newer events. */
  nextSeq: number;
};

export type PaymentInstructions =
  | { route: "x402"; network: string; asset: Address; payTo: Address; amount: string; amountUsd: string }
  | { route: "wallet"; calls: UnsignedCall[]; amountUsd: string };

export type ServiceDeps = {
  quoter: Quoter;
  quoterAddress: Address;
  /** Built by the caller so the engine's events can be routed back into the service. */
  makeEngine: (onEvent: (e: EngineEvent) => void) => Engine;
  merger: Merger;
  receipts: ReceiptChain;
  store: JobStore;
  escrow: Escrow;
  /** §11.2 fan-out for live subscribers (SSE/WebSocket). Every emitted event is also persisted via `store.appendEvent`. */
  bus: EventBus;
  verdictSigner: VerdictSigner;
  /** The operator credited for a host's work. Until outside operators exist, every host is ours. */
  operatorOf?: (hostId: string) => bigint;
  workerOperatorId?: bigint;
  spentMicros?: (jobKey: Hex) => Promise<bigint>;
  now?: () => number;
};

const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/**
 * The job lifecycle behind every interface (§3.3): quote → fund → fan out →
 * check → merge → seal → settle. REST, tRPC, MCP and x402 all call this.
 *
 * In this phase the run, the merge and the settlement happen in this process.
 * From Phase 6 the settlement-keeper takes over sealing and settling.
 */
export class JobService {
  private readonly engine: Engine;
  private readonly now: () => number;
  private readonly tiles = new Map<string, Map<number, string>>();
  private readonly liveTiles = new Map<Hex, TileCoalescer>();
  private readonly lastBatchMs = new Map<Hex, number>();
  private readonly runningLane = new Map<Hex, StoredJob["lane"]>();
  private readonly runs = new Map<Hex, Promise<void>>();

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.engine = deps.makeEngine((e) => this.onEngineEvent(e));
  }

  /** Persists an event and fans it out to live subscribers, in that order so the bus carries the real sequence number. */
  private async emit(jobKey: Hex, type: string, payload: unknown): Promise<void> {
    const event = await this.deps.store.appendEvent(jobKey, type, payload);
    this.deps.bus.publish(jobKey, event);
  }

  private tileCoalescerFor(jobKey: Hex): TileCoalescer {
    let c = this.liveTiles.get(jobKey);
    if (!c) {
      c = new TileCoalescer(10, this.now);
      this.liveTiles.set(jobKey, c);
    }
    return c;
  }

  private async emitEta(jobKey: Hex, lane: StoredJob["lane"]): Promise<void> {
    const { etaSec } = this.engine.scheduler.admission(lane);
    await this.emit(jobKey, "eta", { sec: etaSec });
  }

  private async emitCost(jobKey: Hex, quoteUsd6: bigint): Promise<void> {
    if (!this.deps.spentMicros) return;
    const spent = await this.deps.spentMicros(jobKey).catch(() => undefined);
    if (spent !== undefined) await this.emit(jobKey, "cost", { spentUsd: formatUsd6(spent), quoteUsd: formatUsd6(quoteUsd6) });
  }

  // ───────────────────────── quote ─────────────────────────

  async quote(account: Account, raw: QuoteInput): Promise<QuoteView> {
    const parsed = QuoteInput.safeParse(raw);
    if (!parsed.success) throw new ServiceError("invalid", parsed.error.issues[0]?.message ?? COPY.itemsRequired);
    const input = parsed.data;
    if (input.product === "picket") throw new ServiceError("invalid", COPY.picketNotPerJob);
    if (!input.items?.length || !input.columns?.length) throw new ServiceError("invalid", COPY.itemsRequired);
    if (input.chain !== this.deps.escrow.chain) throw new ServiceError("invalid", COPY.wrongChain);

    const spec = JobSpec.safeParse({
      product: input.product,
      task: input.task,
      items: normalizeItems(input.items, input.chain),
      columns: input.columns,
      tier: input.tier,
      maxAgents: input.maxAgents,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.premiumPlanner !== undefined ? { premiumPlanner: input.premiumPlanner } : {}),
    });
    if (!spec.success) throw new ServiceError("invalid", spec.error.issues[0]?.message ?? COPY.itemsRequired);

    const pricebookKey = (walletJob: boolean): PricebookKey =>
      input.product === "fanout" ? "fanout.job" : walletJob ? "trawl.wallet" : "trawl.token";

    let result: Awaited<ReturnType<Quoter["quote"]>>;
    try {
      result = await this.deps.quoter.quote({ spec: spec.data, pricebookKey, chain: input.chain });
    } catch (e) {
      if (e instanceof QuoteRefused) throw new ServiceError("invalid", COPY.overPlannerBudget);
      if (e instanceof PricingError) throw new ServiceError("invalid", COPY.notOffered);
      throw e;
    }

    const stored: StoredQuote = {
      id: randomUUID(),
      accountId: account.id,
      chain: input.chain,
      pricebookKey: result.lines.pricebookKey,
      quote: result.quote,
      signature: result.signature,
      lines: result.lines,
      spec: result.spec,
      walletJob: result.walletJob,
      tierForced: result.tierForced,
      createdAtMs: this.now(),
    };
    await this.deps.store.putQuote(stored);
    return this.quoteView(stored);
  }

  private quoteView(q: StoredQuote): QuoteView {
    return {
      quoteId: q.id,
      agents: q.lines.agents,
      of: MAX_AGENTS,
      priceUsd: formatUsd6(q.lines.totalUsd6),
      lines: {
        base: formatUsd6(q.lines.baseUsd6),
        rows: formatUsd6(q.lines.rowsUsd6),
        toolsCap: formatUsd6(q.lines.toolsCapUsd6),
      },
      tier: q.spec.tier,
      tierForced: q.tierForced,
      waves: q.lines.waves,
      chain: q.chain,
      expiresAt: new Date(Number(q.quote.expiresAt) * 1000).toISOString(),
    };
  }

  // ───────────────────────── fund ─────────────────────────

  /**
   * Opens the escrow job for a quote and returns how to pay for it. Safe to
   * call again: the same quote always maps to the same job.
   */
  async prepare(
    account: Account,
    quoteId: string,
    route: "x402" | "wallet" | "vault",
    payer?: string,
  ): Promise<{ job: JobView; payment?: PaymentInstructions }> {
    const quote = await this.deps.store.getQuote(quoteId);
    if (!quote || quote.accountId !== account.id) throw new ServiceError("not_found", COPY.notFound);
    if (route !== "vault" && (!payer || !isAddress(payer))) throw new ServiceError("invalid", COPY.payerRequired);

    let job = await this.deps.store.getJobByQuote(quoteId);
    if (!job) {
      try {
        await verifyQuote(quote.spec.product, quote.quote, quote.signature, this.deps.quoterAddress, this.now());
      } catch (e) {
        if (e instanceof QuoteRefused && e.reason === "expired") throw new ServiceError("expired", COPY.quoteExpired);
        throw new ServiceError("invalid", COPY.quoteInvalid);
      }
      const expiresAtSec = Math.floor((this.now() + expiryMs(quote.lines.waves)) / 1000);
      const { jobId, jobKey } = await this.deps.escrow.openJob({
        rows: quote.lines.units,
        unitUsd6: quote.lines.unitUsd6,
        baseUsd6: quote.lines.baseUsd6,
        toolsCapUsd6: quote.lines.toolsCapUsd6,
        workerOperatorId: this.deps.workerOperatorId ?? 1n,
        expiresAtSec,
      });
      job = {
        jobKey,
        jobId,
        quoteId,
        accountId: account.id,
        accountTier: account.tier,
        chain: quote.chain,
        state: "awaiting_payment",
        route,
        lane: quote.spec.lane ?? (account.tier === "holder" ? "priority" : "paid"),
        spec: quote.spec,
        lines: quote.lines,
        walletJob: quote.walletJob,
        createdAtMs: this.now(),
        expiresAtSec,
        ...(payer ? { payer } : {}),
      };
      await this.deps.store.putJob(job);
      await this.emit(jobKey, "job.quoted", {
        agents: quote.lines.agents,
        of: MAX_AGENTS,
        priceUsd: formatUsd6(quote.lines.totalUsd6),
        tier: quote.spec.tier,
      });
    }

    if (job.state !== "awaiting_payment") return { job: this.jobView(job) };
    return { job: this.jobView(job), ...(route === "vault" ? {} : { payment: await this.paymentFor(job) }) };
  }

  private async paymentFor(job: StoredJob): Promise<PaymentInstructions> {
    const amount = job.lines.totalUsd6;
    const payer = job.payer as Address;
    if (job.route === "x402") {
      return {
        route: "x402",
        network: this.deps.escrow.network,
        asset: this.deps.escrow.asset.address,
        payTo: await this.deps.escrow.jobForwarder(job.jobId, payer),
        amount: amount.toString(),
        amountUsd: formatUsd6(amount),
      };
    }
    return {
      route: "wallet",
      calls: await this.deps.escrow.walletFundCalls(job.jobId, payer, amount),
      amountUsd: formatUsd6(amount),
    };
  }

  /** Pays for a quote from the owner's prepaid balance, under their signed grant, and starts the job. */
  async runFromVault(account: Account, quoteId: string, grant: SignedGrant | undefined): Promise<JobView> {
    if (!grant) throw new ServiceError("invalid", COPY.grantRequired);
    const { job } = await this.prepare(account, quoteId, "vault");
    const stored = await this.owned(account, job.jobKey);
    if (stored.state !== "awaiting_payment") return this.jobView(stored);
    await this.deps.escrow.fundFromVault(stored.jobId, grant, stored.lines.totalUsd6);
    return this.jobView(await this.start(stored));
  }

  /**
   * Called once the client says they have paid. Sweeps an x402 forwarder,
   * then starts the job only if the escrow really shows it funded.
   */
  async confirm(account: Account, jobKey: Hex): Promise<JobView> {
    const job = await this.owned(account, jobKey);
    if (job.state !== "awaiting_payment") return this.jobView(job);
    if (job.route === "x402") await this.deps.escrow.sweepJob(job.jobId, job.payer as Address);
    if ((await this.deps.escrow.status(job.jobId)) !== "funded") throw new ServiceError("payment_required", COPY.paymentPending);
    return this.jobView(await this.start(job));
  }

  private async start(job: StoredJob): Promise<StoredJob> {
    const running = await this.deps.store.updateJob(job.jobKey, { state: "running" });
    await this.emit(job.jobKey, "job.funded", { route: job.route, chain: job.chain });
    await this.emitEta(job.jobKey, job.lane);
    const run = this.execute(running).catch(() => {});
    this.runs.set(job.jobKey, run);
    return running;
  }

  /** Resolves when a started job has finished its run and settlement. For tests and graceful shutdown. */
  finished(jobKey: Hex): Promise<void> {
    return this.runs.get(jobKey) ?? Promise.resolve();
  }

  // ───────────────────────── run ─────────────────────────

  private async execute(job: StoredJob): Promise<void> {
    const { store, escrow, receipts } = this.deps;
    this.runningLane.set(job.jobKey, job.lane);
    try {
      const engineJob: EngineJob = {
        spec: job.spec,
        accountTier: job.accountTier,
        toolsCapUsd6: job.lines.toolsCapUsd6,
        ctx: {
          jobKey: job.jobKey,
          product: job.spec.product,
          tier: job.spec.tier,
          walletJob: job.walletJob,
          accountId: job.accountId,
          lane: job.lane,
          freeTier: job.route === "free" || job.route === "credits",
          quoteMicros: job.lines.totalUsd6,
          ...(job.spec.premiumPlanner !== undefined ? { premiumPlanner: job.spec.premiumPlanner } : {}),
        },
      };
      const result = await this.engine.run(engineJob);
      await store.updateJob(job.jobKey, { state: "merging", rows: result.rows });

      const passed = result.rows.flatMap((r) => (r.state === "passed" && r.cells ? [{ rowIdx: r.rowIdx, cells: r.cells }] : []));
      const merged = await this.deps.merger.merge(engineJob, passed);
      await this.emit(job.jobKey, "job.merged", {
        passed: result.passed,
        refunded: result.refunded,
        unverifiedCells: merged.table.unverifiedCells,
      });
      await this.emitCost(job.jobKey, job.lines.totalUsd6);

      const seal = await receipts.seal(job.jobKey);
      const sealTx = (await escrow.seal(job.jobKey, seal)).tx;
      await this.emit(job.jobKey, "job.sealed", { root: seal.root, tx: sealTx });

      const amounts = settlementAmounts(job.lines, result.passed, result.toolsUsd6);
      const operatorOf = this.deps.operatorOf ?? (() => this.deps.workerOperatorId ?? 1n);
      const built = buildVerdict({
        jobKey: job.jobKey,
        rows: result.rows.map((r) => ({
          rowIdx: r.rowIdx,
          passed: r.state === "passed",
          operatorId: operatorOf(r.hostIds[0] ?? ""),
        })),
        receipts: receipts.receipts(job.jobKey),
        unitUsd6: job.lines.unitUsd6,
        toolsUsd6: amounts.toolsBilledUsd6,
      });
      const signature = await signVerdict(this.deps.verdictSigner, escrow.verdictDomain(), built.verdict);
      const settled = await escrow.settle(job.jobId, built.verdict, signature);

      await store.updateJob(job.jobKey, {
        state: result.passed === 0 ? "refunded" : "settled",
        table: merged.table,
        summary: merged.summary,
        verdict: { verdict: built.verdict, signature, rows: built.rows },
        seal,
        sealTx,
        settleTx: settled.tx,
        settledAtMs: this.now(),
        releaseAtSec: settled.releaseAtSec,
        amounts,
      });
      await this.emit(job.jobKey, "job.settled", {
        paidUsd: formatUsd6(amounts.grossUsd6 + amounts.toolsBilledUsd6),
        refundedUsd: formatUsd6(amounts.refundUsd6),
        tx: settled.tx,
      });
      await this.emitCost(job.jobKey, job.lines.totalUsd6);
    } catch {
      // The detail stays in our logs. On-chain the job is still funded, so the
      // payer gets everything back through the expiry refund.
      await store.updateJob(job.jobKey, { state: "failed", error: COPY.runFailed }).catch(() => {});
      await this.emit(job.jobKey, "job.failed", {}).catch(() => {});
    } finally {
      this.tiles.delete(job.jobKey);
      this.liveTiles.delete(job.jobKey);
      this.lastBatchMs.delete(job.jobKey);
      this.runningLane.delete(job.jobKey);
    }
  }

  private onEngineEvent(e: EngineEvent): void {
    const jobKey = e.jobKey as Hex;
    if (e.type === "tile") {
      // The row-state tally behind StatusView.tiles (counts by state, not by agent).
      let rows = this.tiles.get(jobKey);
      if (!rows) {
        rows = new Map();
        this.tiles.set(jobKey, rows);
      }
      rows.set(e.rowIdx, e.state);

      // §11.2 the live per-agent grid: throttled individual tiles, plus a periodic full snapshot.
      const coalescer = this.tileCoalescerFor(jobKey);
      const allowed = coalescer.record(e.agentIdx, e.state);
      if (allowed) void this.emit(jobKey, "tile", { agentIdx: e.agentIdx, rowIdx: e.rowIdx, state: e.state }).catch(() => {});
      const lastBatch = this.lastBatchMs.get(jobKey) ?? 0;
      if (this.now() - lastBatch >= 100) {
        this.lastBatchMs.set(jobKey, this.now());
        void this.emit(jobKey, "tiles.batch", { states: coalescer.snapshotBase64() }).catch(() => {});
      }
      return;
    }
    void this.emit(jobKey, e.type, { wave: e.wave, rows: e.rows }).catch(() => {});
    const lane = this.runningLane.get(jobKey);
    if (lane) void this.emitEta(jobKey, lane).catch(() => {});
  }

  // ───────────────────────── read ─────────────────────────

  /** A job is visible only to the account that owns it; anything else looks like it does not exist. */
  private async owned(account: Account, jobKey: Hex): Promise<StoredJob> {
    const job = await this.deps.store.getJob(jobKey);
    if (!job || job.accountId !== account.id) throw new ServiceError("not_found", COPY.notFound);
    return job;
  }

  private jobView(job: StoredJob): JobView {
    const rows = job.rows ?? [];
    return {
      jobKey: job.jobKey,
      state: job.state,
      agents: job.lines.agents,
      of: MAX_AGENTS,
      quoteUsd: formatUsd6(job.lines.totalUsd6),
      rows: {
        total: job.lines.units,
        passed: rows.filter((r) => r.state === "passed").length,
        refunded: rows.filter((r) => r.state === "refunded").length,
      },
      ...(job.amounts
        ? {
            paidUsd: formatUsd6(job.amounts.grossUsd6 + job.amounts.toolsBilledUsd6),
            refundedUsd: formatUsd6(job.amounts.refundUsd6),
          }
        : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  async get(account: Account, jobKey: Hex): Promise<JobView> {
    return this.jobView(await this.owned(account, jobKey));
  }

  async list(account: Account, limit = 25): Promise<JobView[]> {
    return (await this.deps.store.listJobs(account.id, Math.min(Math.max(limit, 1), 100))).map((j) => this.jobView(j));
  }

  async status(account: Account, jobKey: Hex, sinceSeq = 0): Promise<StatusView> {
    const job = await this.owned(account, jobKey);
    const tiles: Record<string, number> = {};
    for (const state of this.tiles.get(jobKey)?.values() ?? []) tiles[state] = (tiles[state] ?? 0) + 1;
    const events = await this.deps.store.eventsSince(jobKey, sinceSeq, 500);
    const spent = this.deps.spentMicros ? await this.deps.spentMicros(jobKey).catch(() => undefined) : undefined;
    return {
      ...this.jobView(job),
      tiles,
      ...(spent !== undefined ? { spentUsd: formatUsd6(spent) } : {}),
      events,
      nextSeq: events.at(-1)?.seq ?? sinceSeq,
    };
  }

  async result(account: Account, jobKey: Hex, format: "json" | "csv" | "md" = "json") {
    const job = await this.owned(account, jobKey);
    if (!job.table) throw new ServiceError("not_ready", COPY.notFinished);
    const content = format === "csv" ? toCsv(job.table) : format === "md" ? toMarkdown(job.table) : toJson(job.table);
    const view = this.jobView(job);
    return {
      format,
      content,
      summary: job.summary ?? null,
      passed: view.rows.passed,
      refunded: view.rows.refunded,
      unverifiedCells: job.table.unverifiedCells,
    };
  }

  /** §4 transcript: the manifest, the receipts, and for one row its leaf and Merkle proof. */
  async transcript(account: Account, jobKey: Hex, rowIdx?: number) {
    const job = await this.owned(account, jobKey);
    if (!job.verdict || !job.seal) throw new ServiceError("not_ready", COPY.notFinished);
    const quote = await this.deps.store.getQuote(job.quoteId);
    const receipts = this.deps.receipts.receipts(jobKey);
    const row = rowIdx === undefined ? undefined : job.verdict.rows[rowIdx];
    if (rowIdx !== undefined && !row) throw new ServiceError("invalid", COPY.notFound);
    const leaves = receipts.map((r) => r.leaf);
    return jsonSafe({
      manifest: {
        jobKey,
        chain: job.chain,
        specHash: quote?.quote.specHash,
        quoteSig: quote?.signature,
        root: job.seal.root,
        count: job.seal.count,
        head: job.seal.head,
        sealTx: job.sealTx,
        settleTx: job.settleTx,
        verdictSig: job.verdict.signature,
        rowsRoot: job.verdict.verdict.rowsRoot,
      },
      receipts: (rowIdx === undefined ? receipts : receipts.filter((r) => r.rowIdx === rowIdx)).map((r) => ({
        ...r,
        proof: merkleProof(leaves, r.stepIdx),
      })),
      ...(row ? { row } : {}),
    });
  }

  // ───────────────────────── dispute ─────────────────────────

  /**
   * Prepares a dispute over up to 25 passed rows (§3.3 step 8). Returns the
   * fee and what the client's wallet must submit on-chain; the dispute itself
   * is opened by the client, not by us.
   */
  async dispute(account: Account, jobKey: Hex, rowIdx: number[], evidence: string) {
    const job = await this.owned(account, jobKey);
    if (job.state !== "settled" || !job.verdict || !job.releaseAtSec) throw new ServiceError("not_ready", COPY.notFinished);
    if (this.now() / 1000 >= job.releaseAtSec) throw new ServiceError("expired", COPY.disputeClosed);

    const unique = [...new Set(rowIdx)];
    const rows = unique.map((i) => job.verdict!.rows[i]);
    if (unique.length === 0 || unique.length > DISPUTE_MAX_ROWS || unique.length !== rowIdx.length || rows.some((r) => !r?.passed)) {
      throw new ServiceError("invalid", COPY.disputeRows);
    }

    const pending = BigInt(unique.length) * job.lines.unitUsd6;
    const percent = (pending * BigInt(DISPUTE_FEE_BPS)) / 10_000n;
    const feeUsd6 = percent > DISPUTE_MIN_FEE_USD6 ? percent : DISPUTE_MIN_FEE_USD6;
    const id = randomUUID();
    await this.deps.store.putDispute({
      id,
      jobKey,
      accountId: account.id,
      rowIdx: unique,
      feeUsd6,
      evidence: evidence.slice(0, 4000),
      createdAtMs: this.now(),
    });

    const built = buildVerdict({
      jobKey,
      rows: job.verdict.rows.map((r) => ({ rowIdx: r.rowIdx, passed: r.passed, operatorId: r.operatorId })),
      receipts: this.deps.receipts.receipts(jobKey),
      unitUsd6: job.lines.unitUsd6,
      toolsUsd6: job.verdict.verdict.toolsUsd6,
    });
    return jsonSafe({
      disputeId: id,
      feeUsd: formatUsd6(feeUsd6),
      /** Arguments for RowSplit.disputeRows, to be sent from the client's own wallet. */
      onchain: {
        jobId: job.jobId,
        rowIdx: unique,
        operatorIds: rows.map((r) => r!.operatorId),
        receiptsHashes: rows.map((r) => r!.rowReceiptsHash),
        proofs: unique.map((i) => built.proofFor(i)),
      },
    });
  }

  // ───────────────────────── access keys ─────────────────────────

  private async mintKey(accountId: string, owner: string, active: boolean): Promise<{ keyId: string; secret: string }> {
    const keyId = `jk_${randomBytes(6).toString("hex")}`;
    const secret = `${keyId}.${randomBytes(24).toString("base64url")}`;
    await this.deps.store.putApiKey({ keyId, secretHash: hashSecret(secret), accountId, owner, active, createdAtMs: this.now() });
    return { keyId, secret };
  }

  /**
   * Issues a wallet-bound API key (§9.2). The secret is returned once and only
   * its hash is kept. The key's account is its own: naming a wallet here proves
   * nothing, so it must never give access to that wallet's other jobs. The key
   * cannot spend until the owner signs a spend grant; its caps live in that
   * grant, on-chain, not here.
   */
  issueKey(owner: Address): Promise<{ keyId: string; secret: string }> {
    return this.mintKey(`key:${randomUUID()}`, owner, false);
  }

  /**
   * An access key for a caller with no account, so they can read back the
   * quotes and jobs they create. It carries no spending power. Sign-in,
   * proof-of-work and rate limits for this path arrive in Phase 7.
   */
  issueAnonymousKey(): Promise<{ keyId: string; secret: string }> {
    return this.mintKey(`anon:${randomUUID()}`, "", true);
  }

  /** The account a key belongs to, or null if the key is unknown. */
  async accountForKey(secret: string): Promise<Account | null> {
    const key = await this.deps.store.getApiKeyByHash(hashSecret(secret));
    return key ? { id: key.accountId, tier: "paid" } : null;
  }
}
