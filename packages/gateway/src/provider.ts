import type { RawToolCall, WireMessage, wireTools } from "@jelly/policy";
import type { Attestation } from "@jelly/receipts";
import type { Hex } from "viem";
import { z } from "zod";
import type { HostSpec } from "./hosts";
import type { ModelId } from "./models";
import type { TokenUsage } from "./pricing";

export type ChatRequest = {
  model: ModelId;
  /** The shared prefix: system prompt, then tools. Identical across a job's workers. */
  system: string;
  tools: ReturnType<typeof wireTools>;
  messages: WireMessage[];
  maxOutputTokens: number;
  temperature?: number;
  seed?: number;
};

export type ChatResponse = {
  content: string;
  toolCalls: RawToolCall[];
  usage: TokenUsage;
  /** Hardware attestation, from TEE hosts only. */
  attestation?: Attestation;
  /** A community node's own signature over the output hash. */
  nodeSignature?: Hex;
};

export interface ChatProvider {
  chat(host: HostSpec, req: ChatRequest): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  constructor(
    readonly hostId: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const Completion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().nullish() }).nullish(),
  }),
});

export type AttestationReader = (host: HostSpec, response: Response) => Attestation | undefined;

export type OpenAICompatOptions = {
  /** API key per host id. Hosts without a key are called without an Authorization header. */
  apiKeys?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Extracts hardware attestation from a TEE host's response. There is no
   * default: the header format is a day-1 check (docs/day1.md, item 8), and
   * until a reader is supplied, TEE-only calls fail closed in the gateway.
   */
  readAttestation?: AttestationReader;
  /**
   * A 429 is retried against the *same* host before the gateway's own
   * "one retry, on a different host" policy ever sees it — with one host
   * configured (common in dev, and not unheard of in production), that
   * policy's retry just re-hits the same rate limit with no delay. Honors
   * `Retry-After` when the host sends one, else backs off by attempt number.
   */
  rateLimitRetries?: number;
  maxRateLimitDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds or an HTTP-date, per RFC 9110 — null if absent or unparseable. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Client for any OpenAI-compatible `/chat/completions` endpoint (hosted routers, vLLM, TEE hosts). */
export class OpenAICompatProvider implements ChatProvider {
  constructor(private readonly opts: OpenAICompatOptions = {}) {}

  async chat(host: HostSpec, req: ChatRequest): Promise<ChatResponse> {
    const doFetch = this.opts.fetch ?? fetch;
    const key = this.opts.apiKeys?.[host.id];
    const body = {
      model: host.models[req.model]?.wireName ?? req.model,
      messages: [{ role: "system", content: req.system }, ...req.messages],
      ...(req.tools.length > 0 ? { tools: req.tools } : {}),
      max_tokens: req.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    };

    const url = `${host.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const sleep = this.opts.sleep ?? defaultSleep;
    const maxAttempts = 1 + (this.opts.rateLimitRetries ?? 3);
    const maxDelayMs = this.opts.maxRateLimitDelayMs ?? 15_000;

    let res: Response;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
        });
      } catch (e) {
        throw new ProviderError(host.id, null, `request failed: ${e instanceof Error ? e.name : "error"}`);
      }
      if (res.status !== 429 || attempt >= maxAttempts) break;
      // A fresh or low-tier key's rate limit resets fast; a single unpaced retry on the engine's
      // own "different host" policy would just re-hit it immediately, so back off here instead.
      const delayMs = Math.min(maxDelayMs, retryAfterMs(res.headers.get("retry-after")) ?? 500 * 2 ** (attempt - 1));
      await sleep(delayMs);
    }
    // Never include the response body in the error: it may echo job content into logs.
    if (!res.ok) throw new ProviderError(host.id, res.status, `host returned HTTP ${res.status}`);

    const parsed = Completion.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ProviderError(host.id, res.status, "host returned an unrecognised response");

    const message = parsed.data.choices[0]!.message;
    const usage = parsed.data.usage;
    const cached = Math.min(usage.prompt_tokens_details?.cached_tokens ?? 0, usage.prompt_tokens);
    const attestation = this.opts.readAttestation?.(host, res);
    return {
      content: message.content ?? "",
      toolCalls: (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      usage: { inputTokens: usage.prompt_tokens, cachedInputTokens: cached, outputTokens: usage.completion_tokens },
      ...(attestation ? { attestation } : {}),
    };
  }
}
