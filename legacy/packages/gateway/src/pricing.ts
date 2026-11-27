import type { ModelPrice } from "./hosts";

export type TokenUsage = {
  /** All input tokens, including any served from cache. */
  inputTokens: number;
  /** The part of inputTokens that was a cache read. */
  cachedInputTokens: number;
  outputTokens: number;
};

const PER_MILLION = 1_000_000n;

/** Cost in micro-dollars, rounded up so a call is never under-counted. */
export function costMicros(price: ModelPrice, usage: TokenUsage): bigint {
  const tokens = (n: number, name: string): bigint => {
    if (!Number.isInteger(n) || n < 0) throw new Error(`invalid ${name}: ${n}`);
    return BigInt(n);
  };
  const input = tokens(usage.inputTokens, "inputTokens");
  const cached = tokens(usage.cachedInputTokens, "cachedInputTokens");
  const output = tokens(usage.outputTokens, "outputTokens");
  if (cached > input) throw new Error("cachedInputTokens cannot exceed inputTokens");

  const cachedPrice = price.cachedInMicrosPerM ?? price.inMicrosPerM;
  const total = (input - cached) * price.inMicrosPerM + cached * cachedPrice + output * price.outMicrosPerM;
  return (total + PER_MILLION - 1n) / PER_MILLION;
}

/** Rough token count for text: about 4 characters per token, rounded up. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * What to reserve before a call: every input token at the fresh price and the
 * full output allowance. Deliberately pessimistic; the settle step returns
 * whatever was not spent.
 */
export const reservationMicros = (price: ModelPrice, estInputTokens: number, maxOutputTokens: number): bigint =>
  costMicros(price, { inputTokens: estInputTokens, cachedInputTokens: 0, outputTokens: maxOutputTokens });

/**
 * What the call is expected to cost on this host, for ranking: the shared
 * prefix is priced as a cache read where the host offers one.
 */
export const effectiveMicros = (
  price: ModelPrice,
  estInputTokens: number,
  prefixTokens: number,
  maxOutputTokens: number,
): bigint =>
  costMicros(price, {
    inputTokens: estInputTokens,
    cachedInputTokens: Math.min(prefixTokens, estInputTokens),
    outputTokens: maxOutputTokens,
  });
