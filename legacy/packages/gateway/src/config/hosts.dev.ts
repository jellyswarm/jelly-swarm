import type { HostInput } from "../hosts";

/**
 * Development host registry. NOT for production: every host is marked
 * `pricesConfirmed: false`, and the gateway refuses such hosts when
 * NODE_ENV=production.
 *
 * Prices are micro-dollars per million tokens. Only three come from the
 * overview document:
 *   - DeepSeek V4 Flash  $0.14 in / $0.28 out
 *   - gpt-oss-120b       $0.037 in / $0.17 out
 *   - V4 Flash at the TEE host: $0.44 fresh input, $0.028 cache read
 * Every other number below is a placeholder so local runs have something to
 * rank by. Replace them with real provider prices (docs/day1.md, items 7-8).
 *
 * Host ids are neutral labels. Internal router brand names must not appear.
 */
const PLACEHOLDER = { inMicrosPerM: 500_000n, outMicrosPerM: 1_500_000n };

export const DEV_HOSTS: HostInput[] = [
  {
    id: "router-a",
    kind: "router",
    baseUrl: "http://localhost:4010/v1",
    pricesConfirmed: false,
    sloP95Ms: 30_000,
    models: {
      "deepseek-v4-pro": PLACEHOLDER,
      "deepseek-v4-flash": { inMicrosPerM: 140_000n, outMicrosPerM: 280_000n },
      "gpt-oss-120b": { inMicrosPerM: 37_000n, outMicrosPerM: 170_000n },
      "gpt-oss-20b": PLACEHOLDER,
      "qwen-3.6-35b-a3b": PLACEHOLDER,
      "qwen3.8-27b": PLACEHOLDER,
      "glm-5.3-flash": PLACEHOLDER,
      "glm-5.2": PLACEHOLDER,
      "kimi-k3": PLACEHOLDER,
    },
  },
  {
    id: "router-b",
    kind: "router",
    baseUrl: "http://localhost:4011/v1",
    pricesConfirmed: false,
    sloP95Ms: 30_000,
    models: {
      "deepseek-v4-pro": PLACEHOLDER,
      "deepseek-v4-flash": { inMicrosPerM: 140_000n, outMicrosPerM: 280_000n },
      "gpt-oss-120b": { inMicrosPerM: 37_000n, outMicrosPerM: 170_000n },
      "glm-5.3-flash": PLACEHOLDER,
    },
  },
  {
    id: "batch",
    kind: "batch",
    baseUrl: "http://localhost:4012/v1",
    pricesConfirmed: false,
    sloP95Ms: 600_000,
    models: {
      "deepseek-v4-flash": PLACEHOLDER,
      "gpt-oss-120b": PLACEHOLDER,
      "glm-5.3-flash": PLACEHOLDER,
    },
  },
  {
    id: "tee",
    kind: "tee",
    baseUrl: "http://localhost:4013/v1",
    pricesConfirmed: false,
    sloP95Ms: 60_000,
    models: {
      "kimi-k3": PLACEHOLDER,
      "deepseek-v4.1-flash": { inMicrosPerM: 440_000n, outMicrosPerM: 1_500_000n, cachedInMicrosPerM: 28_000n },
      "glm-5.3-flash": PLACEHOLDER,
    },
  },
];
