import type { Product, Role, Tier } from "@jelly/shared";
import { CrossFamilyViolation } from "./errors";
import { DOWNGRADE, type Family, LONG_CONTEXT_TOKENS, type ModelId, familyOf } from "./models";

/** Models a role may use, in order of preference: the first is the default, the rest are fallbacks. */
export type RolePolicy = Record<Role, readonly ModelId[]>;

export type RoutingPolicy = {
  tiers: Record<Tier, RolePolicy>;
  /** Picket has its own role table, independent of tier (§2.2). */
  picket: RolePolicy;
  /** Swapped in for the planner when `premiumPlanner` is set. */
  premiumPlanner: ModelId;
  /** Where long documents go, per tier. */
  longContext: Record<Tier, ModelId>;
};

/** §2.2 tier policy defaults. */
export const DEFAULT_POLICY: RoutingPolicy = {
  tiers: {
    open: {
      intake: ["deepseek-v4-pro"],
      planner: ["deepseek-v4-pro"],
      worker: ["gpt-oss-120b"],
      checker: ["glm-5.3-flash"],
      merger: ["deepseek-v4-pro"],
      spotter: ["deepseek-v4-pro"],
    },
    standard: {
      intake: ["deepseek-v4-pro"],
      planner: ["deepseek-v4-pro", "glm-5.2"],
      worker: ["deepseek-v4-flash", "qwen-3.6-35b-a3b", "qwen3.8-27b"],
      checker: ["glm-5.3-flash"],
      merger: ["deepseek-v4-pro"],
      spotter: ["deepseek-v4-pro"],
    },
    sealed: {
      intake: ["kimi-k3"],
      planner: ["kimi-k3"],
      worker: ["deepseek-v4.1-flash"],
      checker: ["glm-5.3-flash"],
      merger: ["kimi-k3"],
      spotter: ["kimi-k3"],
    },
  },
  picket: {
    intake: ["deepseek-v4-pro"],
    planner: ["deepseek-v4-pro"],
    // "triage" in Picket's vocabulary
    worker: ["gpt-oss-20b", "qwen-3.6-35b-a3b"],
    checker: ["glm-5.3-flash"],
    // "scribe"
    merger: ["deepseek-v4-flash"],
    spotter: ["deepseek-v4-pro"],
  },
  premiumPlanner: "kimi-k3",
  longContext: {
    open: "deepseek-v4-flash",
    standard: "deepseek-v4-flash",
    sealed: "deepseek-v4.1-flash",
  },
};

export type RouteQuery = {
  product: Product;
  tier: Tier;
  role: Role;
  premiumPlanner?: boolean;
  /** Estimated input tokens for this call. */
  estInputTokens?: number;
  /** True when the heartbeat says to drop one model class. */
  downgraded?: boolean;
};

const rolePolicy = (policy: RoutingPolicy, product: Product, tier: Tier): RolePolicy =>
  product === "picket" ? policy.picket : policy.tiers[tier];

/** Ordered candidate models for one call, before host filtering. */
export function candidateModels(policy: RoutingPolicy, q: RouteQuery): ModelId[] {
  let models: ModelId[] = [...rolePolicy(policy, q.product, q.tier)[q.role]];

  if (q.role === "planner" && q.premiumPlanner) models = [policy.premiumPlanner];

  if (q.role === "worker" && (q.estInputTokens ?? 0) > LONG_CONTEXT_TOKENS) {
    models = [policy.longContext[q.tier]];
  }

  if (q.role === "worker" && q.downgraded) {
    // Put the lower class first; keep the original as a fallback in case no
    // eligible host serves the lower class (e.g. a TEE-only job).
    const lowered = models.flatMap((m) => (DOWNGRADE[m] ? [DOWNGRADE[m]] : []));
    models = [...new Set([...lowered, ...models])];
  }
  return models;
}

/** Every family a role could run on for this product and tier, including downgrades and long-context. */
export function possibleFamilies(policy: RoutingPolicy, product: Product, tier: Tier, role: Role): Set<Family> {
  const models = new Set<ModelId>(rolePolicy(policy, product, tier)[role]);
  if (role === "worker") {
    models.add(policy.longContext[tier]);
    for (const m of [...models]) if (DOWNGRADE[m]) models.add(DOWNGRADE[m]);
  }
  if (role === "planner") models.add(policy.premiumPlanner);
  return new Set([...models].map(familyOf));
}

/**
 * §2.2 cross-family rule, checked statically: no model the checker could use
 * may share a family with any model a worker could use.
 */
export function assertCrossFamily(policy: RoutingPolicy, product: Product, tier: Tier): void {
  const workers = possibleFamilies(policy, product, tier, "worker");
  const checkers = possibleFamilies(policy, product, tier, "checker");
  for (const f of checkers) {
    if (workers.has(f)) throw new CrossFamilyViolation(f, `${product}/${tier} policy`);
  }
}
