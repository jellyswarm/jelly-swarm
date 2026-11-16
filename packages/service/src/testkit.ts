import { jobBudgetKey } from "@jelly/budget-guard";
import { Checker, JUDGE_PROMPT } from "@jelly/checker";
import { fakeChain, fakeWeb, judgeSays, makeGateway, signer } from "@jelly/checker/src/testkit";
import { Engine, JobGuards, Quoter, type ToolExecutor, WORKER_PROMPT, runRow } from "@jelly/engine";
import { type MockHandler, mockResponse } from "@jelly/gateway";
import { InMemoryEventBus } from "@jelly/live";
import { Merger } from "@jelly/merger";
import { NO_TOOLS } from "@jelly/policy";
import type { TemplateRegistry } from "@jelly/templates";
import { keccak256, toBytes } from "viem";
import { MemoryEscrow } from "./escrow";
import { JobService } from "./service";
import { MemoryJobStore } from "./store";

/**
 * A whole JobService wired in memory: mock model hosts, a fake web, the real
 * engine, checker and merger, and the in-memory escrow and store. Test-only.
 *
 * Items are named `tok-<n>`; each has a page saying it has 1000+n holders.
 * An item named `bad-<n>` makes the worker report a wrong number, so its row
 * fails the checker and is refunded.
 */
export const COLUMNS = [{ name: "holders", type: "number" as const, needsSource: true }];
export const SUMMARY = "Every listed token has a holder count with a source.";

const noTools: ToolExecutor = {
  run: async () => {
    throw new Error("no tools in tests");
  },
};

const numberOf = (raw: string) => 1000 + Number(raw.split("-")[1] ?? "0");

export const defaultHandler: MockHandler = (_host, req) => {
  if (req.system === WORKER_PROMPT) {
    const raw = /"raw":"([^"]+)"/.exec(req.messages[0]!.content)![1]!;
    const value = raw.startsWith("bad") ? 999_999 : numberOf(raw);
    return mockResponse({
      content: JSON.stringify({
        cells: { holders: { value, source: { url: `https://s.example/${raw}`, quoteSpan: `has ${numberOf(raw)} holders` } } },
      }),
      usage: { inputTokens: 200, cachedInputTokens: 0, outputTokens: 100 },
    });
  }
  if (req.system === JUDGE_PROMPT) return judgeSays(true);
  return mockResponse({ content: SUMMARY, usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 40 } });
};

export function makeService(over: { handler?: MockHandler; items?: string[]; templates?: TemplateRegistry } = {}) {
  const clock = { now: 1_800_000_000_000 };
  const now = () => clock.now;
  const g = makeGateway(over.handler ?? defaultHandler);
  const items = over.items ?? Array.from({ length: 40 }, (_, i) => `tok-${i}`).concat(["bad-1", "bad-2"]);
  const web = fakeWeb(Object.fromEntries(items.map((raw) => [`https://s.example/${raw}`, `${raw} has ${numberOf(raw)} holders.`])));
  const checker = new Checker({ gateway: g.gateway, fetcher: web.fetcher, chain: fakeChain({}) });
  const escrow = new MemoryEscrow(now);
  const store = new MemoryJobStore(now);
  const bus = new InMemoryEventBus();

  let dryRuns = 0;
  const quoter = new Quoter({
    signer,
    now,
    inspector: { evmCodeSize: async () => 1, solanaAccountKind: async () => "mint" },
    // The dry run is real worker calls on the sample, under its own small budget that is never billed.
    runSample: async (spec, itemIdx, walletJob) => {
      const out = await runRow({
        gateway: g.gateway,
        job: {
          jobKey: keccak256(toBytes(`dry-run-${dryRuns++}`)),
          product: spec.product,
          tier: spec.tier,
          walletJob,
          accountId: "studio:dry-run",
          lane: "paid",
          freeTier: false,
          quoteMicros: 50_000n,
        },
        spec,
        rowIdx: itemIdx,
        slot: 1,
        manifest: NO_TOOLS("worker"),
        tools: noTools,
        guards: new JobGuards(0n),
        receipts: g.receipts,
      });
      return { costMicros: out.costMicros, toolsUsd6: out.toolsUsd6 };
    },
  });

  const service = new JobService({
    quoter,
    quoterAddress: signer.address,
    makeEngine: (onEvent) =>
      new Engine({
        gateway: g.gateway,
        checker: checker.asRowChecker(),
        workerManifest: NO_TOOLS("worker"),
        tools: noTools,
        receipts: g.receipts,
        onEvent,
      }),
    merger: new Merger({ gateway: g.gateway }),
    receipts: g.receipts,
    store,
    escrow,
    bus,
    verdictSigner: signer,
    spentMicros: async (jobKey) => (await g.budget.usage(jobBudgetKey(jobKey))).usedMicros,
    now,
    ...(over.templates ? { templates: over.templates } : {}),
  });

  return { service, escrow, store, bus, clock, provider: g.provider, receipts: g.receipts };
}
