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
};

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

    let res: Response;
    try {
      res = await doFetch(`${host.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new ProviderError(host.id, null, `request failed: ${e instanceof Error ? e.name : "error"}`);
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
