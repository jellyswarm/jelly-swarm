import { randomUUID } from "node:crypto";
import { type BudgetLimits, type BudgetStore, budgetKeys, jobBudgetKey, utcDay } from "@jelly/budget-guard";
import {
  type Message,
  type RawToolCall,
  type RejectedToolCall,
  type RoleManifest,
  type ToolCall,
  type TrustedPrompt,
  assertTrustedPrompt,
  checkToolCalls,
  toWire,
  wireTools,
} from "@jelly/policy";
import {
  NO_ROW,
  type ReceiptChain,
  type SignedReceipt,
  ZERO32,
  attestationRef,
  hashJson,
  hashLabel,
} from "@jelly/receipts";
import { type Lane, type Product, ROLE_ID, ROUTER, type Role, type Tier } from "@jelly/shared";
import type { Hex } from "viem";
import {
  AllHostsFailed,
  BudgetExceeded,
  BudgetOverrun,
  CrossFamilyViolation,
  MissingAttestation,
  NoEligibleHost,
  PolicyViolation,
} from "./errors";
import { HealthTracker } from "./health";
import { type Heartbeat, heartbeatFor } from "./heartbeat";
import { type HostInput, HostSpec, type ModelPrice, hostLabel, hostRefusal, isCommunity, isTee, priceFor } from "./hosts";
import { type Family, type ModelId, familyOf } from "./models";
import { PrefixGate } from "./prefix";
import { type TokenUsage, costMicros, effectiveMicros, estimateTokens, reservationMicros } from "./pricing";
import type { ChatProvider, ChatRequest, ChatResponse } from "./provider";
import { DEFAULT_POLICY, type RoutingPolicy, assertCrossFamily, candidateModels } from "./routing";

export type JobContext = {
  jobKey: Hex;
  product: Product;
  tier: Tier;
  /** True if any item is a wallet address. Such a job must be Sealed. */
  walletJob: boolean;
  accountId: string;
  lane: Lane;
  /** Free-tier and credit-funded jobs also count against the free-tier daily budget. */
  freeTier: boolean;
  /** The job's quote in micro-dollars: the hard cap on its spend (§0.4). */
  quoteMicros: bigint;
  premiumPlanner?: boolean;
};

export type GatewayCall = {
  job: JobContext;
  role: Role;
  /** Receipt agent id; see AGENT_ID in @jelly/receipts. */
  agentId: number;
  rowIdx?: number;
  /** A registered prompt. Text built at runtime is refused. */
  system: TrustedPrompt;
  manifest: RoleManifest;
  messages: Message[];
  maxOutputTokens: number;
  /** Overrides the built-in estimate (about 4 characters per token). */
  estInputTokens?: number;
  /** Hosts to avoid, e.g. the one that produced a row the checker rejected. */
  excludeHosts?: readonly string[];
  temperature?: number;
  seed?: number;
};

export type GatewayResult = {
  content: string;
  /** Tool calls that name a tool in the manifest and parse against its schema. */
  toolCalls: ToolCall[];
  /** The accepted calls as returned by the model, for replay in the next turn. */
  rawToolCalls: RawToolCall[];
  rejectedToolCalls: RejectedToolCall[];
  usage: TokenUsage;
  costMicros: bigint;
  model: ModelId;
  hostId: string;
  receipt: SignedReceipt;
  heartbeat: Heartbeat;
};

export type GatewayAlert =
  | { kind: "overrun"; jobKey: Hex; hostId: string; reservedMicros: bigint; actualMicros: bigint }
  | { kind: "missing_attestation"; jobKey: Hex; hostId: string }
  | { kind: "host_failed"; jobKey: Hex; hostId: string; error: string };

export type GatewayDeps = {
  hosts: readonly HostInput[];
  provider: ChatProvider;
  budget: BudgetStore;
  limits: BudgetLimits;
  receipts: ReceiptChain;
  policy?: RoutingPolicy;
  health?: HealthTracker;
  now?: () => number;
  onAlert?: (alert: GatewayAlert) => void;
  /** How long an unsettled reservation is held before it may be reaped. */
  reservationTtlMs?: number;
  /** Refuse to start with placeholder prices. Defaults to true in production. */
  requireConfirmedPrices?: boolean;
};

type Candidate = { host: HostSpec; model: ModelId; price: ModelPrice; effective: bigint; modelRank: number };

/** §13: an overrun above 20% of the reservation fails the row and alerts. */
const OVERRUN_TOLERANCE_BPS = 2000n;

/**
 * The single door to every model host (§2.3). For each call it picks a model
 * and host under the tier, privacy and health rules, reserves the cost
 * against the job's quote, makes the call, settles the real cost, and emits a
 * signed receipt.
 *
 * Per-job state (which model families the job has used) and host health are
 * held in this process.
 */
export class Gateway {
  private readonly hosts: HostSpec[];
  private readonly policy: RoutingPolicy;
  private readonly health: HealthTracker;
  private readonly prefix = new PrefixGate();
  private readonly now: () => number;
  private readonly families = new Map<Hex, { worker: Set<Family>; checker: Set<Family> }>();

  constructor(private readonly deps: GatewayDeps) {
    this.hosts = deps.hosts.map((h) => HostSpec.parse(h));
    const ids = new Set<string>();
    for (const h of this.hosts) {
      if (ids.has(h.id)) throw new Error(`duplicate host id: ${h.id}`);
      ids.add(h.id);
    }
    const requireConfirmed = deps.requireConfirmedPrices ?? process.env.NODE_ENV === "production";
    if (requireConfirmed) {
      const placeholder = this.hosts.filter((h) => h.enabled && !h.pricesConfirmed).map((h) => h.id);
      if (placeholder.length > 0) {
        throw new Error(`hosts with unconfirmed prices cannot be used here: ${placeholder.join(", ")}`);
      }
    }
    this.policy = deps.policy ?? DEFAULT_POLICY;
    this.health = deps.health ?? new HealthTracker();
    this.now = deps.now ?? Date.now;
  }

  /** How much of the job's quote is left, and what that means for routing and scheduling. */
  async heartbeat(job: Pick<JobContext, "jobKey" | "quoteMicros">): Promise<Heartbeat> {
    const usage = await this.deps.budget.usage(jobBudgetKey(job.jobKey));
    return heartbeatFor(job.quoteMicros, usage.usedMicros);
  }

  /** Drops per-job state once a job is finished. */
  forgetJob(jobKey: Hex): void {
    this.families.delete(jobKey);
    this.prefix.forget(`${jobKey}:`);
  }

  async call(call: GatewayCall): Promise<GatewayResult> {
    const { job, role } = call;

    // ── policy checks that need no I/O ──
    assertTrustedPrompt(call.system);
    if (call.manifest.role !== role) {
      throw new PolicyViolation(`manifest for role "${call.manifest.role}" used by role "${role}"`);
    }
    if (job.walletJob && job.tier !== "sealed") {
      throw new PolicyViolation("a job with wallet addresses must run on the Sealed tier");
    }
    if (job.quoteMicros <= 0n) throw new PolicyViolation("a job needs a positive quote");
    if (!Number.isInteger(call.maxOutputTokens) || call.maxOutputTokens <= 0) {
      throw new PolicyViolation("maxOutputTokens must be a positive integer");
    }
    assertCrossFamily(this.policy, job.product, job.tier);

    // ── budget state ──
    const heartbeat = await this.heartbeat(job);
    if (heartbeat.level === "stop") {
      throw new BudgetExceeded({ key: jobBudgetKey(job.jobKey), reason: "stopped" });
    }

    // ── build the request ──
    const tools = wireTools(call.manifest);
    const messages = toWire(call.messages);
    const prefixText = call.system + JSON.stringify(tools);
    const prefixTokens = estimateTokens(prefixText);
    const estInputTokens = call.estInputTokens ?? prefixTokens + estimateTokens(JSON.stringify(messages));

    // ── choose where it can run ──
    const candidates = this.rank(call, heartbeat, estInputTokens, prefixTokens);
    const teeRequired = job.tier === "sealed" || job.walletJob;
    const scope = {
      jobKey: job.jobKey,
      quoteMicros: job.quoteMicros,
      role,
      accountId: job.accountId,
      lane: job.lane,
      freeTier: job.freeTier,
    };

    const tried = new Set<string>();
    const failures: { hostId: string; error: string }[] = [];
    const maxHosts = 1 + ROUTER.maxFallbackHosts;

    for (const c of candidates) {
      if (tried.has(c.host.id)) continue;
      if (tried.size >= maxHosts) break;
      tried.add(c.host.id);

      const reserved = reservationMicros(c.price, estInputTokens, call.maxOutputTokens);
      const reservationId = randomUUID();
      const startedAt = this.now();
      const refusal = await this.deps.budget.reserve(
        reservationId,
        budgetKeys({ ...scope, day: utcDay(startedAt) }, this.deps.limits),
        reserved,
        startedAt + (this.deps.reservationTtlMs ?? 10 * 60_000),
      );
      // A budget refusal is final: trying another host would not make room.
      if (!refusal.ok) throw new BudgetExceeded(refusal);

      const request: ChatRequest = {
        model: c.model,
        system: call.system,
        tools,
        messages,
        maxOutputTokens: call.maxOutputTokens,
        ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
        ...(call.seed !== undefined ? { seed: call.seed } : {}),
      };

      let response: ChatResponse;
      let cost: bigint;
      this.health.begin(c.host.id);
      try {
        response = await this.prefix.run(`${job.jobKey}:${c.host.id}:${c.model}:${hashLabel(prefixText)}`, () =>
          this.deps.provider.chat(c.host, request),
        );
        cost = costMicros(c.price, response.usage);
      } catch (e) {
        const error = e instanceof Error ? e.message : "unknown error";
        await this.deps.budget.release(reservationId);
        this.health.record(c.host.id, false, this.now() - startedAt, this.now());
        failures.push({ hostId: c.host.id, error });
        this.deps.onAlert?.({ kind: "host_failed", jobKey: job.jobKey, hostId: c.host.id, error });
        continue;
      } finally {
        this.health.end(c.host.id);
      }
      this.health.record(c.host.id, true, this.now() - startedAt, this.now());

      const settled = await this.deps.budget.settle(reservationId, cost);

      // ── receipt: one per call that cost money, whatever happens next ──
      const attestation = isTee(c.host) ? response.attestation : undefined;
      const { accepted, rejected } = checkToolCalls(call.manifest, response.toolCalls);
      const receipt = await this.deps.receipts.append(
        {
          jobKey: job.jobKey,
          agentId: call.agentId,
          role: ROLE_ID[role],
          rowIdx: call.rowIdx ?? NO_ROW,
          inputHash: hashJson({ model: c.model, system: call.system, tools, messages }),
          toolCallsHash: hashJson(response.toolCalls),
          modelId: hashLabel(c.model),
          host: hashLabel(hostLabel(c.host)),
          costMicros: cost,
          outputHash: hashJson({ content: response.content, toolCalls: response.toolCalls }),
          attestationRef: attestation ? attestationRef(attestation.receiptId, attestation.quoteHash) : ZERO32,
        },
        {
          ...(attestation ? { attestation } : {}),
          ...(isCommunity(c.host) && response.nodeSignature ? { nodeSignature: response.nodeSignature } : {}),
        },
      );
      this.noteFamily(job.jobKey, role, familyOf(c.model));

      if (teeRequired && !attestation) {
        this.deps.onAlert?.({ kind: "missing_attestation", jobKey: job.jobKey, hostId: c.host.id });
        throw new MissingAttestation(c.host.id);
      }
      if (settled.overrunMicros * 10_000n > settled.reservedMicros * OVERRUN_TOLERANCE_BPS) {
        this.deps.onAlert?.({
          kind: "overrun",
          jobKey: job.jobKey,
          hostId: c.host.id,
          reservedMicros: settled.reservedMicros,
          actualMicros: cost,
        });
        throw new BudgetOverrun(settled.reservedMicros, cost, receipt);
      }

      const acceptedIds = new Set(accepted.map((a) => a.id));
      return {
        content: response.content,
        toolCalls: accepted,
        rawToolCalls: response.toolCalls.filter((t) => acceptedIds.has(t.id)),
        rejectedToolCalls: rejected,
        usage: response.usage,
        costMicros: cost,
        model: c.model,
        hostId: c.host.id,
        receipt,
        heartbeat,
      };
    }

    throw new AllHostsFailed(failures);
  }

  /** §2.3 steps 1-4: candidates, host policy, health, then rank by price and queue depth. */
  private rank(call: GatewayCall, heartbeat: Heartbeat, estInputTokens: number, prefixTokens: number): Candidate[] {
    const { job, role } = call;
    let models = candidateModels(this.policy, {
      product: job.product,
      tier: job.tier,
      role,
      estInputTokens,
      downgraded: heartbeat.level === "downgrade",
      ...(job.premiumPlanner !== undefined ? { premiumPlanner: job.premiumPlanner } : {}),
    });

    // Cross-family rule at run time, against what this job has actually used.
    const used = this.families.get(job.jobKey);
    const clash = role === "checker" ? used?.worker : role === "worker" ? used?.checker : undefined;
    if (clash && clash.size > 0) {
      const allowed = models.filter((m) => !clash.has(familyOf(m)));
      if (allowed.length === 0) throw new CrossFamilyViolation(familyOf(models[0]!), `job ${job.jobKey}`);
      models = allowed;
    }

    const now = this.now();
    const exclude = new Set(call.excludeHosts ?? []);
    const skipped = new Map<string, string>();
    const out: Candidate[] = [];

    models.forEach((model, modelRank) => {
      for (const host of this.hosts) {
        const price = priceFor(host, model);
        if (!price) continue;
        const why =
          hostRefusal(host, { product: job.product, tier: job.tier, role, lane: job.lane, walletJob: job.walletJob }) ??
          (exclude.has(host.id) ? "excluded by caller" : null) ??
          this.health.unhealthy(host.id, host.sloP95Ms, now);
        if (why) {
          skipped.set(host.id, why);
          continue;
        }
        out.push({
          host,
          model,
          price,
          modelRank,
          effective: effectiveMicros(price, estInputTokens, prefixTokens, call.maxOutputTokens),
        });
      }
    });

    if (out.length === 0) {
      const reasons = [...skipped].map(([id, why]) => `${id}: ${why}`).join("; ");
      throw new NoEligibleHost(
        `${job.product}/${job.tier}/${role} on [${models.join(", ")}]${reasons ? ` (${reasons})` : " (no host serves these models)"}`,
      );
    }

    return out.sort(
      (a, b) =>
        a.modelRank - b.modelRank ||
        (a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : 0) ||
        this.health.depth(a.host.id) - this.health.depth(b.host.id) ||
        a.host.id.localeCompare(b.host.id),
    );
  }

  private noteFamily(jobKey: Hex, role: Role, family: Family): void {
    if (role !== "worker" && role !== "checker") return;
    let f = this.families.get(jobKey);
    if (!f) {
      f = { worker: new Set(), checker: new Set() };
      this.families.set(jobKey, f);
    }
    f[role].add(family);
  }
}
