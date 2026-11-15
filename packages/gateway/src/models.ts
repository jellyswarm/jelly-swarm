/**
 * Open-weight models the engine routes to (§2.2). A model's *family* is what
 * the cross-family rule compares: the checker must come from a different
 * family than every worker on the job.
 */
export type Family = "deepseek" | "openai-oss" | "qwen" | "zai" | "moonshot";

export type ModelInfo = { family: Family };

export const MODELS = {
  "deepseek-v4-pro": { family: "deepseek" },
  "deepseek-v4-flash": { family: "deepseek" },
  "deepseek-v4.1-flash": { family: "deepseek" },
  "gpt-oss-120b": { family: "openai-oss" },
  "gpt-oss-20b": { family: "openai-oss" },
  "qwen-3.6-35b-a3b": { family: "qwen" },
  "qwen3.8-27b": { family: "qwen" },
  "glm-5.3-flash": { family: "zai" },
  "glm-5.2": { family: "zai" },
  "kimi-k3": { family: "moonshot" },
  "kimi-k2.6": { family: "moonshot" },
} as const satisfies Record<string, ModelInfo>;

export type ModelId = keyof typeof MODELS;

export const isModelId = (id: string): id is ModelId => Object.hasOwn(MODELS, id);

export const familyOf = (id: ModelId): Family => MODELS[id].family;

/** §2.2 "Long documents": inputs over this many tokens go to a V4 Flash model (1M context). */
export const LONG_CONTEXT_TOKENS = 100_000;

/** §2.3 Heartbeat downgrade: "drop one model class (V4 Flash → gpt-oss-120b)". */
export const DOWNGRADE: Partial<Record<ModelId, ModelId>> = {
  "deepseek-v4-flash": "gpt-oss-120b",
};
