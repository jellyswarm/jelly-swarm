import { type BudgetLimits, MemoryBudgetStore } from "@jelly/budget-guard";
import { type Column, type EngineJob, type JobSpec, WORKER_PROMPT, normalizeItems, priceJob } from "@jelly/engine";
import { FetchBlocked, type PageFetcher } from "@jelly/fetcher";
import { Gateway, type HostInput, type MockHandler, MockProvider, mockResponse } from "@jelly/gateway";
import { ReceiptChain } from "@jelly/receipts";
import { MAX_AGENTS } from "@jelly/shared";
import type { ChainReader } from "@jelly/tools";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Shared fixtures for checker and merger tests. Test-only: uses well-known anvil keys. */
export const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const receiptDomainParams = {
  chainId: 8453,
  verifyingContract: "0x00000000000000000000000000000000000000aa",
  salt: keccak256(toBytes("fanout")),
} as const;

const P = { inMicrosPerM: 500_000n, outMicrosPerM: 1_500_000n };
const router = (id: string, flashIn: bigint): HostInput => ({
  id,
  kind: "router",
  baseUrl: "http://localhost:1/v1",
  pricesConfirmed: true,
  sloP95Ms: 30_000,
  models: {
    "deepseek-v4-pro": P,
    "deepseek-v4-flash": { inMicrosPerM: flashIn, outMicrosPerM: 280_000n },
    "gpt-oss-120b": { inMicrosPerM: 37_000n, outMicrosPerM: 170_000n },
    "glm-5.3-flash": P,
  },
});

const LIMITS: BudgetLimits = {
  accountDayMicros: 10n ** 12n,
  laneDayMicros: { priority: 10n ** 12n, paid: 10n ** 12n, free: 10n ** 12n, deferred: 10n ** 12n },
  globalDayMicros: 10n ** 12n,
  freeTierDayMicros: 10n ** 12n,
};

export const USAGE = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 40 };
export const judgeSays = (pass: boolean, failingCells: string[] = [], reason = "ok") =>
  mockResponse({ content: JSON.stringify({ pass, failingCells, reason }), usage: USAGE });

export const isWorkerCall = (system: string) => system === WORKER_PROMPT;

export function makeGateway(handler: MockHandler = () => judgeSays(true)) {
  const provider = new MockProvider(handler);
  const budget = new MemoryBudgetStore();
  const receipts = new ReceiptChain(receiptDomainParams, signer);
  const gateway = new Gateway({
    hosts: [router("r1", 140_000n), router("r2", 150_000n), router("r3", 160_000n)],
    provider,
    budget,
    limits: LIMITS,
    receipts,
  });
  return { gateway, provider, budget, receipts };
}

/** A fake web: URL → page text. Anything else is a 404. Records what was fetched. */
export function fakeWeb(pages: Record<string, string>) {
  const fetched: string[] = [];
  const fetcher: PageFetcher = {
    fetchText: async (url) => {
      fetched.push(url);
      const text = pages[url];
      if (text === undefined) throw new FetchBlocked("status", "HTTP 404");
      return { url, status: 200, contentType: "text/html", text };
    },
  };
  return { fetcher, fetched, pages };
}

export const fakeChain = (results: Record<string, unknown>): ChainReader => ({
  read: async (req) => {
    const key = `${req.address}:${req.method}`;
    if (!(key in results)) throw new Error("no such read");
    return results[key];
  },
});

let seq = 0;
export function makeJob(items: string[], columns: Column[], over: { quoteMicros?: bigint } = {}): EngineJob {
  const spec: JobSpec = {
    product: "fanout",
    task: "Fill the columns for each token.",
    items: normalizeItems(items),
    columns,
    tier: "standard",
    maxAgents: MAX_AGENTS,
  };
  return {
    spec,
    accountTier: "paid",
    toolsCapUsd6: 0n,
    ctx: {
      jobKey: keccak256(toBytes(`check-job-${seq++}`)),
      product: "fanout",
      tier: "standard",
      walletJob: false,
      accountId: "acct-1",
      lane: "paid",
      freeTier: false,
      quoteMicros: over.quoteMicros ?? priceJob("fanout.job", { tier: "standard", pieces: items.length, maxAgents: MAX_AGENTS }).totalUsd6,
    },
  };
}

/** Small seeded PRNG so the accuracy test is the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
