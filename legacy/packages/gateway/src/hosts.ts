import type { Lane, Product, Role, Tier } from "@jelly/shared";
import { z } from "zod";
import { type ModelId, isModelId } from "./models";

/** Price per million tokens, in micro-dollars. $0.14 / M tokens = 140_000n. */
export const ModelPrice = z.object({
  inMicrosPerM: z.bigint().nonnegative(),
  outMicrosPerM: z.bigint().nonnegative(),
  /** Price for input tokens served from the host's prompt cache, if it has one. */
  cachedInMicrosPerM: z.bigint().nonnegative().optional(),
  /** The name this host uses for the model, if it differs from our id. */
  wireName: z.string().min(1).optional(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/** §5: the community node image serves only these models. */
export const COMMUNITY_MODELS: readonly ModelId[] = ["gpt-oss-120b", "gpt-oss-20b", "qwen-3.6-35b-a3b", "qwen3.8-27b"];

export const HostSpec = z
  .object({
    /** Neutral label. Its keccak hash goes into receipts; never an internal brand name. */
    id: z.string().regex(/^[a-z0-9][a-z0-9:-]*$/),
    /**
     * router: an internal model router. batch: off-peak batch windows.
     * tee: attested GPU-TEE hardware. crypto: crypto-funded hosted route.
     * rented: self-hosted vLLM on rented GPUs. community: an outside operator's node.
     */
    kind: z.enum(["router", "batch", "tee", "crypto", "rented", "community"]),
    baseUrl: z.string().url(),
    /** Community nodes: the operator id, used for the receipt host label and payouts. */
    operatorId: z.bigint().optional(),
    enabled: z.boolean().default(true),
    /** False while prices are placeholders. Production refuses such hosts. */
    pricesConfirmed: z.boolean(),
    /** p95 latency objective; a host slower than this is skipped. */
    sloP95Ms: z.number().int().positive(),
    models: z.record(z.string(), ModelPrice),
  })
  .superRefine((h, ctx) => {
    for (const m of Object.keys(h.models)) {
      if (!isModelId(m)) ctx.addIssue({ code: "custom", message: `unknown model: ${m}` });
    }
    if (h.kind === "community") {
      if (h.operatorId === undefined) ctx.addIssue({ code: "custom", message: "a community host needs an operatorId" });
      for (const m of Object.keys(h.models)) {
        if (!COMMUNITY_MODELS.includes(m as ModelId)) {
          ctx.addIssue({ code: "custom", message: `community nodes may not serve ${m}` });
        }
      }
    }
  });
export type HostSpec = z.infer<typeof HostSpec>;
/** A host as written in config: `enabled` may be left out. */
export type HostInput = z.input<typeof HostSpec>;

export const isTee = (h: HostSpec): boolean => h.kind === "tee";
export const isCommunity = (h: HostSpec): boolean => h.kind === "community";

/** Label hashed into the receipt's `host` field (§4). */
export const hostLabel = (h: HostSpec): string => (isCommunity(h) ? `node:${h.operatorId}` : h.id);

export const priceFor = (h: HostSpec, model: ModelId): ModelPrice | undefined => h.models[model];

export type HostQuery = {
  product: Product;
  tier: Tier;
  role: Role;
  lane: Lane;
  walletJob: boolean;
};

/** Products whose Open-tier workers may run on community nodes. v1: Fanout only (§5). */
export const COMMUNITY_PRODUCTS: readonly Product[] = ["fanout"];

/**
 * §2.3 step 2, host policy. Returns why a host may not serve this call, or
 * null if it may. These rules are privacy and trust boundaries, so nothing
 * downstream is allowed to relax them.
 */
export function hostRefusal(h: HostSpec, q: HostQuery): string | null {
  if (!h.enabled) return "disabled";

  // Sealed jobs and any job touching a wallet address run on TEE hosts only.
  if ((q.tier === "sealed" || q.walletJob) && !isTee(h)) return "tee-only job";

  if (isCommunity(h)) {
    // Planner, checker and merger never run on community nodes (§0.7).
    if (q.role !== "worker") return "community nodes serve workers only";
    if (q.tier !== "open") return "community nodes serve the Open tier only";
    if (q.walletJob) return "wallet jobs never run on community nodes";
    if (!COMMUNITY_PRODUCTS.includes(q.product)) return `community nodes do not serve ${q.product}`;
  }

  // Batch windows serve only work the user chose to defer.
  if (h.kind === "batch" && q.lane !== "deferred") return "batch windows serve the deferred lane only";

  return null;
}
