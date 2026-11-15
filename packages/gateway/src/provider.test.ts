import { afterAll, describe, expect, test } from "bun:test";
import { envelope, toWire } from "@jelly/policy";
import { keccak256, toBytes } from "viem";
import { HostSpec, OpenAICompatProvider, ProviderError, costMicros, estimateTokens, reservationMicros } from "./index";

// A local stand-in for an OpenAI-compatible host.
let lastRequest: { auth: string | null; body: Record<string, unknown> } | undefined;
let mode: "ok" | "500" | "garbage" | "tools" = "ok";
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    lastRequest = { auth: req.headers.get("authorization"), body: (await req.json()) as Record<string, unknown> };
    if (mode === "500") return new Response("secret upstream detail", { status: 500 });
    if (mode === "garbage") return Response.json({ hello: "world" });
    return Response.json(
      {
        choices: [
          {
            message:
              mode === "tools"
                ? { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fetch_url", arguments: '{"url":"https://example.com"}' } }] }
                : { content: "42 holders" },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } },
      },
      { headers: { "x-receipt-id": "rid-9" } },
    );
  },
});
afterAll(() => server.stop(true));

const host = HostSpec.parse({
  id: "local",
  kind: "tee",
  baseUrl: `http://localhost:${server.port}/v1/`,
  pricesConfirmed: true,
  sloP95Ms: 1000,
  models: { "deepseek-v4-flash": { inMicrosPerM: 140_000n, outMicrosPerM: 280_000n, wireName: "vendor/v4-flash" } },
});
const request = {
  model: "deepseek-v4-flash" as const,
  system: "You research one item.",
  tools: [],
  messages: toWire([{ role: "data", envelopes: [envelope("user", "task.v1", { item: "x" })] }]),
  maxOutputTokens: 64,
  temperature: 0,
  seed: 7,
};

describe("OpenAI-compatible provider", () => {
  test("sends the system prompt first, the host's model name, and the bearer key", async () => {
    mode = "ok";
    const provider = new OpenAICompatProvider({ apiKeys: { local: "test-key" } });
    const res = await provider.chat(host, request);
    expect(res).toEqual({
      content: "42 holders",
      toolCalls: [],
      usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 8 },
    });
    expect(lastRequest?.auth).toBe("Bearer test-key");
    expect(lastRequest?.body).toMatchObject({ model: "vendor/v4-flash", max_tokens: 64, temperature: 0, seed: 7 });
    const messages = lastRequest?.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: "You research one item." });
    expect(messages[1]!.role).toBe("user");
    expect(lastRequest?.body.tools).toBeUndefined();
  });

  test("parses tool calls and tolerates null content", async () => {
    mode = "tools";
    const res = await new OpenAICompatProvider().chat(host, request);
    expect(res.content).toBe("");
    expect(res.toolCalls).toEqual([{ id: "c1", name: "fetch_url", arguments: '{"url":"https://example.com"}' }]);
    expect(lastRequest?.auth).toBeNull();
  });

  test("attestation is read only through the supplied reader", async () => {
    mode = "ok";
    const quoteHash = keccak256(toBytes("q"));
    const without = await new OpenAICompatProvider().chat(host, request);
    expect(without.attestation).toBeUndefined();
    const withReader = await new OpenAICompatProvider({
      readAttestation: (_h, r) => ({ receiptId: r.headers.get("x-receipt-id")!, quoteHash }),
    }).chat(host, request);
    expect(withReader.attestation).toEqual({ receiptId: "rid-9", quoteHash });
  });

  test("an HTTP error becomes a ProviderError that does not leak the response body", async () => {
    mode = "500";
    const err = await new OpenAICompatProvider().chat(host, request).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain("secret");
  });

  test("an unrecognised response and an unreachable host are ProviderErrors", async () => {
    mode = "garbage";
    await expect(new OpenAICompatProvider().chat(host, request)).rejects.toThrow(ProviderError);
    const dead = { ...host, baseUrl: "http://127.0.0.1:1/v1" };
    await expect(new OpenAICompatProvider({ timeoutMs: 2000 }).chat(dead, request)).rejects.toThrow(ProviderError);
  });
});

describe("pricing", () => {
  const price = { inMicrosPerM: 140_000n, outMicrosPerM: 280_000n };

  test("cost rounds up to the next micro-dollar", () => {
    expect(costMicros(price, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })).toBe(0n);
    expect(costMicros(price, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 })).toBe(1n);
    expect(costMicros(price, { inputTokens: 8_000, cachedInputTokens: 0, outputTokens: 1_500 })).toBe(1_540n);
  });

  test("a full-width Standard job at the doc's assumed 8K in / 1.5K out per call costs about $0.39 in workers", () => {
    const perCall = costMicros(price, { inputTokens: 8_000, cachedInputTokens: 0, outputTokens: 1_500 });
    expect(perCall * 250n).toBe(385_000n);
  });

  test("cached input uses the cached price when the host has one, else the fresh price", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 };
    expect(costMicros({ ...price, cachedInMicrosPerM: 28_000n }, usage)).toBe(28_000n);
    expect(costMicros(price, usage)).toBe(140_000n);
  });

  test("invalid usage is rejected", () => {
    expect(() => costMicros(price, { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 })).toThrow();
    expect(() => costMicros(price, { inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 0 })).toThrow();
    expect(() => costMicros(price, { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 })).toThrow();
  });

  test("the reservation assumes no cache and the full output allowance", () => {
    expect(reservationMicros({ ...price, cachedInMicrosPerM: 1n }, 1_000_000, 1_000_000)).toBe(420_000n);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
