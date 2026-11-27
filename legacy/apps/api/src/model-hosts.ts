import type { HostInput } from "@jelly/gateway";

/**
 * Model wiring for one OpenAI-compatible host (OpenRouter by default — any
 * OpenAI-compatible router works the same way). `wireName` is OpenRouter's
 * own catalog slug for each model, confirmed live against
 * GET https://openrouter.ai/api/v1/models on 2026-11-16 — OpenRouter's
 * lineup changes, so re-check there if a call starts 404ing.
 *
 * None of these five families (deepseek, gpt-oss, qwen, GLM, kimi) currently
 * have a `:free`-suffixed slug on OpenRouter — only unrelated models do
 * (nvidia/google/etc., outside this project's model registry). Calling any
 * of these needs real OpenRouter credit on the account the key belongs to;
 * they are cheap (open-weight model pricing), not free.
 *
 * `sloP95Ms` and prices are placeholders (`pricesConfirmed: false`): the
 * Gateway refuses to use a host with unconfirmed prices once
 * NODE_ENV=production (see packages/gateway/src/gateway.ts), so this host
 * is safe to ship as a default but inert until an API key is set and the
 * numbers below are checked against OpenRouter's real per-token pricing.
 */
export function defaultModelHost(apiKey: string | undefined, baseUrl: string): HostInput | undefined {
  if (!apiKey) return undefined;
  return {
    id: "openrouter",
    kind: "router",
    baseUrl,
    enabled: true,
    pricesConfirmed: false,
    sloP95Ms: 20_000,
    // in/outMicrosPerM read from OpenRouter's own per-token USD pricing on 2026-11-16
    // (price_per_token × 1e12 = micro-dollars per million tokens).
    models: {
      "kimi-k3": { inMicrosPerM: 192_000n, outMicrosPerM: 16_000_000n, wireName: "moonshotai/kimi-k3" },
      "kimi-k2.6": { inMicrosPerM: 650_000n, outMicrosPerM: 3_410_000n, wireName: "moonshotai/kimi-k2.6" },
      "deepseek-v4-flash": { inMicrosPerM: 90_000n, outMicrosPerM: 180_000n, wireName: "deepseek/deepseek-v4-flash" },
      "deepseek-v4-pro": { inMicrosPerM: 900_000n, outMicrosPerM: 1_500_000n, wireName: "deepseek/deepseek-v4-pro" },
      "qwen-3.6-35b-a3b": { inMicrosPerM: 140_000n, outMicrosPerM: 800_000n, wireName: "qwen/qwen3-235b-a22b-2507" },
      "qwen3.8-27b": { inMicrosPerM: 140_000n, outMicrosPerM: 800_000n, wireName: "qwen/qwen3-235b-a22b-2507" },
      "glm-5.3-flash": { inMicrosPerM: 130_000n, outMicrosPerM: 850_000n, wireName: "z-ai/glm-4.5-air" },
      "glm-5.2": { inMicrosPerM: 600_000n, outMicrosPerM: 2_200_000n, wireName: "z-ai/glm-4.5" },
      "gpt-oss-120b": { inMicrosPerM: 150_000n, outMicrosPerM: 600_000n, wireName: "openai/gpt-oss-120b" },
      "gpt-oss-20b": { inMicrosPerM: 75_000n, outMicrosPerM: 300_000n, wireName: "openai/gpt-oss-20b" },
    },
  };
}
