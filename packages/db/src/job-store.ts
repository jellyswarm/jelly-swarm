import { randomUUID } from "node:crypto";
import type {
  JobEvent,
  JobStore,
  StoredApiKey,
  StoredCreditEntry,
  StoredDispute,
  StoredJob,
  StoredQuote,
  StoredReferral,
  StoredShare,
} from "@jelly/service";
import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import type { Hex } from "viem";
import type { Db } from "./index";
import { decodeJsonb, encodeJsonb } from "./json-codec";
import * as schema from "./schema";

const toDate = (ms: number): Date => new Date(ms);
const toMs = (d: Date | null): number | undefined => (d === null ? undefined : d.getTime());

/**
 * Postgres-backed JobStore (§8, day1.md #23). Each row carries the full
 * StoredJob/StoredQuote as a jsonb blob (`job` / `extra`) so no field is
 * lost to a partial column mapping; the flat columns exist only for the
 * filters this interface's listX methods actually need (state, account,
 * createdAt, volumeRecordedAt), matching the rest of the schema's columns.
 */
export class PgJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  async putQuote(q: StoredQuote): Promise<void> {
    await this.db
      .insert(schema.quotes)
      .values({
        id: q.id,
        accountId: q.accountId,
        spec: q.spec,
        specHash: q.quote.specHash,
        product: q.spec.product,
        tier: q.spec.tier,
        chain: q.chain,
        units: q.quote.units,
        maxAgents: q.quote.maxAgents,
        unitUsd6: q.quote.unitUsd6,
        baseUsd6: q.quote.baseUsd6,
        toolsCapUsd6: q.quote.toolsCapUsd6,
        estCostUsd6: q.lines.totalUsd6,
        signature: q.signature,
        createdAt: toDate(q.createdAtMs),
        expiresAt: toDate(Number(q.quote.expiresAt) * 1000),
        extra: encodeJsonb(q),
      })
      .onConflictDoNothing();
  }

  async getQuote(id: string): Promise<StoredQuote | undefined> {
    const [row] = await this.db.select().from(schema.quotes).where(eq(schema.quotes.id, id)).limit(1);
    return row ? decodeJsonb<StoredQuote>(row.extra) : undefined;
  }

  private jobRow(j: StoredJob) {
    const rows: NonNullable<StoredJob["rows"]> = j.rows ?? [];
    const passedCount = j.rows ? rows.filter((r) => r.state === "passed").length : null;
    const costUsd6 = rows.reduce((sum, r) => sum + r.costMicros, 0n);
    return {
      jobKey: j.jobKey,
      chain: j.chain,
      onchainJobId: j.jobId.toString(),
      quoteId: j.quoteId,
      accountId: j.accountId,
      product: j.spec.product,
      tier: j.spec.tier,
      lane: j.lane,
      state: j.state,
      fundingRoute: j.route,
      funder: j.payer ?? null,
      walletJob: j.walletJob,
      budgetUsd6: j.lines.totalUsd6,
      rowCount: j.lines.units,
      passedCount,
      toolsUsd6: j.amounts?.toolsBilledUsd6 ?? null,
      costUsd6,
      receiptsRoot: j.seal?.root ?? null,
      receiptsCount: j.seal?.count ?? null,
      receiptsHead: j.seal?.head ?? null,
      rowsRoot: j.verdict?.verdict.rowsRoot ?? null,
      verdictSig: j.verdict?.signature ?? null,
      sealTx: j.sealTx ?? null,
      settleTx: j.settleTx ?? null,
      finalizeTx: j.finalizeTx ?? null,
      meterBucket: j.meterBucket ?? null,
      createdAt: toDate(j.createdAtMs),
      settledAt: j.settledAtMs !== undefined ? toDate(j.settledAtMs) : null,
      releaseAt: j.releaseAtSec !== undefined ? toDate(j.releaseAtSec * 1000) : null,
      finalizedAt: j.finalizedAtMs !== undefined ? toDate(j.finalizedAtMs) : null,
      expiredAt: toDate(j.expiresAtSec * 1000),
      volumeRecordedAt: j.volumeRecordedAtMs !== undefined ? toDate(j.volumeRecordedAtMs) : null,
      job: encodeJsonb(j),
    };
  }

  async putJob(j: StoredJob): Promise<void> {
    const row = this.jobRow(j);
    await this.db
      .insert(schema.jobs)
      .values(row)
      .onConflictDoUpdate({ target: schema.jobs.jobKey, set: row });
  }

  async getJob(jobKey: Hex): Promise<StoredJob | undefined> {
    const [row] = await this.db.select({ job: schema.jobs.job }).from(schema.jobs).where(eq(schema.jobs.jobKey, jobKey)).limit(1);
    return row ? decodeJsonb<StoredJob>(row.job) : undefined;
  }

  async getJobByQuote(quoteId: string): Promise<StoredJob | undefined> {
    const [row] = await this.db.select({ job: schema.jobs.job }).from(schema.jobs).where(eq(schema.jobs.quoteId, quoteId)).limit(1);
    return row ? decodeJsonb<StoredJob>(row.job) : undefined;
  }

  async updateJob(jobKey: Hex, patch: Partial<StoredJob>): Promise<StoredJob> {
    const current = await this.getJob(jobKey);
    if (!current) throw new Error(`unknown job ${jobKey}`);
    const next = { ...current, ...patch };
    await this.putJob(next);
    return next;
  }

  async listJobs(accountId: string, limit: number): Promise<StoredJob[]> {
    const rows = await this.db
      .select({ job: schema.jobs.job })
      .from(schema.jobs)
      .where(eq(schema.jobs.accountId, accountId))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(limit);
    return rows.map((r) => decodeJsonb<StoredJob>(r.job));
  }

  async listAwaitingFinalize(): Promise<StoredJob[]> {
    const rows = await this.db.select({ job: schema.jobs.job }).from(schema.jobs).where(eq(schema.jobs.state, "settled"));
    return rows.map((r) => decodeJsonb<StoredJob>(r.job));
  }

  async listForVolume(sinceMs: number, untilMs: number): Promise<StoredJob[]> {
    const rows = await this.db
      .select({ job: schema.jobs.job })
      .from(schema.jobs)
      .where(
        and(
          isNull(schema.jobs.volumeRecordedAt),
          gte(schema.jobs.createdAt, toDate(sinceMs)),
          lt(schema.jobs.createdAt, toDate(untilMs)),
        ),
      );
    return rows
      .map((r) => decodeJsonb<StoredJob>(r.job))
      .filter((j) => j.state === "finalized" || j.state === "refunded");
  }

  async listAll(sinceMs: number, untilMs: number): Promise<StoredJob[]> {
    const rows = await this.db
      .select({ job: schema.jobs.job })
      .from(schema.jobs)
      .where(and(gte(schema.jobs.createdAt, toDate(sinceMs)), lt(schema.jobs.createdAt, toDate(untilMs))));
    return rows.map((r) => decodeJsonb<StoredJob>(r.job));
  }

  async appendEvent(jobKey: Hex, type: string, payload: unknown): Promise<JobEvent> {
    return this.db.transaction(async (tx) => {
      const [last] = await tx
        .select({ seq: schema.jobEvents.seq })
        .from(schema.jobEvents)
        .where(eq(schema.jobEvents.jobKey, jobKey))
        .orderBy(desc(schema.jobEvents.seq))
        .limit(1);
      const seq = (last ? last.seq : 0n) + 1n;
      const [row] = await tx
        .insert(schema.jobEvents)
        .values({ jobKey, seq, type, payload: encodeJsonb(payload) })
        .returning({ ts: schema.jobEvents.ts });
      return { seq: Number(seq), ts: row!.ts.getTime(), type, payload };
    });
  }

  async eventsSince(jobKey: Hex, sinceSeq: number, limit: number): Promise<JobEvent[]> {
    const rows = await this.db
      .select()
      .from(schema.jobEvents)
      .where(and(eq(schema.jobEvents.jobKey, jobKey), gte(schema.jobEvents.seq, BigInt(sinceSeq) + 1n)))
      .orderBy(schema.jobEvents.seq)
      .limit(limit);
    return rows.map((r) => ({ seq: Number(r.seq), ts: r.ts.getTime(), type: r.type, payload: decodeJsonb(r.payload) }));
  }

  async putDispute(d: StoredDispute): Promise<void> {
    await this.db.insert(schema.disputes).values({
      id: d.id,
      jobKey: d.jobKey,
      accountId: d.accountId,
      rowIdx: d.rowIdx,
      feeUsd6: d.feeUsd6,
      kind: "client",
      evidence: { evidence: d.evidence },
      createdAt: toDate(d.createdAtMs),
    });
  }

  async putApiKey(k: StoredApiKey): Promise<void> {
    await this.db
      .insert(schema.apiKeys)
      .values({
        keyId: k.keyId,
        keyHash: Buffer.from(k.secretHash, "hex"),
        accountId: k.accountId,
        walletAddress: k.owner,
        // StoredApiKey carries no chain; "base" matches this project's only confirmed EVM chain today.
        chain: "base",
        grantKeyId: k.active ? k.keyId : null,
        createdAt: toDate(k.createdAtMs),
      })
      .onConflictDoNothing();
  }

  async getApiKeyByHash(secretHash: string): Promise<StoredApiKey | undefined> {
    const target = Buffer.from(secretHash, "hex");
    const [row] = await this.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyHash, target)).limit(1);
    if (!row) return undefined;
    return {
      keyId: row.keyId,
      secretHash,
      accountId: row.accountId,
      owner: row.walletAddress,
      active: row.grantKeyId !== null && row.revokedAt === null,
      createdAtMs: row.createdAt.getTime(),
    };
  }

  async putShare(s: StoredShare): Promise<void> {
    await this.db
      .insert(schema.shareLinks)
      .values({
        slug: s.slug,
        jobKey: s.jobKey,
        accountId: s.accountId,
        visibility: s.visibility,
        snapshot: encodeJsonb(s.snapshot),
        templateVersion: s.templateVersion ?? null,
        createdAt: toDate(s.createdAtMs),
      })
      .onConflictDoNothing();
  }

  async getShare(slug: string): Promise<StoredShare | undefined> {
    const [row] = await this.db.select().from(schema.shareLinks).where(eq(schema.shareLinks.slug, slug)).limit(1);
    return row ? this.toShare(row) : undefined;
  }

  async updateShare(slug: string, patch: Partial<StoredShare>): Promise<StoredShare> {
    const current = await this.getShare(slug);
    if (!current) throw new Error(`unknown share ${slug}`);
    const next = { ...current, ...patch };
    await this.db
      .update(schema.shareLinks)
      .set({
        visibility: next.visibility,
        snapshot: encodeJsonb(next.snapshot),
        templateVersion: next.templateVersion ?? null,
      })
      .where(eq(schema.shareLinks.slug, slug));
    return next;
  }

  async listSharesForJob(jobKey: Hex): Promise<StoredShare[]> {
    const rows = await this.db.select().from(schema.shareLinks).where(eq(schema.shareLinks.jobKey, jobKey));
    return rows.map((r) => this.toShare(r));
  }

  private toShare(row: typeof schema.shareLinks.$inferSelect): StoredShare {
    return {
      slug: row.slug,
      jobKey: row.jobKey as Hex,
      accountId: row.accountId,
      visibility: row.visibility as StoredShare["visibility"],
      snapshot: decodeJsonb(row.snapshot),
      ...(row.templateVersion !== null ? { templateVersion: row.templateVersion } : {}),
      createdAtMs: row.createdAt.getTime(),
    };
  }

  async putReferral(r: StoredReferral): Promise<void> {
    await this.db.insert(schema.referrals).values({
      id: r.id,
      refCode: r.refCode,
      referrer: r.referrerAccountId,
      referee: r.refereeAccountId,
      state: r.state,
      blockReason: r.blockReason ?? null,
      qualifyingJobKey: r.qualifyingJobKey ?? null,
      createdAt: toDate(r.createdAtMs),
    });
  }

  async getReferralByReferee(refereeAccountId: string): Promise<StoredReferral | undefined> {
    const [row] = await this.db.select().from(schema.referrals).where(eq(schema.referrals.referee, refereeAccountId)).limit(1);
    return row ? this.toReferral(row) : undefined;
  }

  async updateReferral(id: string, patch: Partial<StoredReferral>): Promise<StoredReferral> {
    const [row] = await this.db.select().from(schema.referrals).where(eq(schema.referrals.id, id)).limit(1);
    if (!row) throw new Error(`unknown referral ${id}`);
    const next = { ...this.toReferral(row), ...patch };
    await this.db
      .update(schema.referrals)
      .set({
        state: next.state,
        blockReason: next.blockReason ?? null,
        qualifyingJobKey: next.qualifyingJobKey ?? null,
      })
      .where(eq(schema.referrals.id, id));
    return next;
  }

  private toReferral(row: typeof schema.referrals.$inferSelect): StoredReferral {
    return {
      id: row.id,
      refCode: row.refCode,
      referrerAccountId: row.referrer,
      refereeAccountId: row.referee,
      state: row.state as StoredReferral["state"],
      ...(row.blockReason ? { blockReason: row.blockReason } : {}),
      ...(row.qualifyingJobKey ? { qualifyingJobKey: row.qualifyingJobKey as Hex } : {}),
      createdAtMs: row.createdAt.getTime(),
    };
  }

  async countPaidReferralsSince(referrerAccountId: string, sinceMs: number): Promise<number> {
    const rows = await this.db
      .select({ id: schema.referrals.id })
      .from(schema.referrals)
      .where(
        and(
          eq(schema.referrals.referrer, referrerAccountId),
          eq(schema.referrals.state, "paid"),
          gte(schema.referrals.createdAt, toDate(sinceMs)),
        ),
      );
    return rows.length;
  }

  async getReferralCode(accountId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ code: schema.referralCodes.code })
      .from(schema.referralCodes)
      .where(eq(schema.referralCodes.accountId, accountId))
      .limit(1);
    return row?.code;
  }

  async putReferralCode(accountId: string, code: string): Promise<void> {
    await this.db.insert(schema.referralCodes).values({ accountId, code }).onConflictDoNothing();
  }

  async getAccountForReferralCode(code: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ accountId: schema.referralCodes.accountId })
      .from(schema.referralCodes)
      .where(eq(schema.referralCodes.code, code))
      .limit(1);
    return row?.accountId;
  }

  async addCredit(e: StoredCreditEntry): Promise<void> {
    await this.db.insert(schema.creditLedger).values({
      accountId: e.accountId,
      deltaUsd6: e.deltaUsd6,
      reason: e.reason,
      jobKey: e.jobKey ?? null,
      createdAt: toDate(e.createdAtMs),
      expiresAt: e.expiresAtMs !== undefined ? toDate(e.expiresAtMs) : null,
    });
  }

  async creditBalance(accountId: string, nowMs: number): Promise<bigint> {
    const rows = await this.db
      .select({ deltaUsd6: schema.creditLedger.deltaUsd6, expiresAt: schema.creditLedger.expiresAt })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.accountId, accountId));
    const now = toDate(nowMs);
    return rows
      .filter((r) => r.deltaUsd6 < 0n || r.expiresAt === null || r.expiresAt > now)
      .reduce((sum, r) => sum + r.deltaUsd6, 0n);
  }
}

export const newId = (): string => randomUUID();
