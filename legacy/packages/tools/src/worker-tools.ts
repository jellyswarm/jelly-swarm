import { ChainRead, type ToolExecutor, type ToolOutput } from "@jelly/engine";
import { FetchBlocked, type PageFetcher } from "@jelly/fetcher";
import { type ToolCall, defineManifest, envelope } from "@jelly/policy";
import { z } from "zod";
import type { ChainReader } from "./chain";

const FetchUrlInput = z.object({ url: z.string().url().max(2000) });

/**
 * §13: workers have read-only fetch and chain-read tools only. There is no
 * tool that signs, sends, buys or spawns, and `defineManifest` would refuse one.
 */
export const WORKER_MANIFEST = defineManifest("worker", [
  {
    name: "fetch_url",
    description:
      "Fetch one public web page and return its visible text. Sign-in pages and paths a site's robots.txt disallows are refused.",
    input: FetchUrlInput,
  },
  {
    name: "chain_read",
    description:
      'Call a read-only (view or pure) contract function. `method` is a full signature, e.g. "function totalSupply() view returns (uint256)".',
    input: ChainRead,
  },
]);

export type WorkerToolsOptions = {
  fetcher: PageFetcher;
  chain: ChainReader;
  /** Page text beyond this many characters is cut before it reaches the model. */
  maxPageChars?: number;
};

/**
 * Runs the worker manifest's tools. Every result is wrapped as data. A
 * refusal is also returned as data, with a short reason that never contains
 * page content, so the model can try another source.
 */
export class WorkerTools implements ToolExecutor {
  constructor(private readonly opts: WorkerToolsOptions) {}

  async run(call: ToolCall): Promise<ToolOutput> {
    switch (call.name) {
      case "fetch_url": {
        const { url } = FetchUrlInput.parse(call.input);
        try {
          const page = await this.opts.fetcher.fetchText(url);
          const max = this.opts.maxPageChars ?? 20_000;
          return {
            envelope: envelope("tool:fetch_url", "page.v1", {
              url: page.url,
              text: page.text.slice(0, max),
              truncated: page.text.length > max,
            }),
          };
        } catch (e) {
          const reason = e instanceof FetchBlocked ? e.reason : "failed";
          return { envelope: envelope("tool:fetch_url", "page-error.v1", { url, error: reason }) };
        }
      }
      case "chain_read": {
        const req = ChainRead.parse(call.input);
        try {
          return { envelope: envelope("tool:chain_read", "chain-read.v1", { ...req, result: await this.opts.chain.read(req) }) };
        } catch {
          return { envelope: envelope("tool:chain_read", "chain-read-error.v1", { ...req, error: "read failed" }) };
        }
      }
      default:
        throw new Error(`no such tool: ${call.name}`);
    }
  }
}
