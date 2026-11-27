import { describe, expect, test } from "bun:test";
import { FetchBlocked, type PageFetcher } from "@jelly/fetcher";
import { checkToolCalls } from "@jelly/policy";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { ChainReadRefused, ChainReaders, EvmChainReader, WORKER_MANIFEST, WorkerTools } from "./index";

const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const HOLDER = "0x000000000000000000000000000000000000dEaD";
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
]);

// A fake JSON-RPC node that answers eth_call for the two view functions above.
const calls: { to: string; data: string }[] = [];
const client = createPublicClient({
  transport: custom({
    request: async ({ method, params }: { method: string; params: [{ to: string; data: `0x${string}` }] }) => {
      if (method === "eth_chainId") return "0x2105";
      if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
      const [{ to, data }] = params;
      calls.push({ to, data });
      const { functionName } = decodeFunctionData({ abi, data });
      if (functionName === "balanceOf") return encodeFunctionResult({ abi, functionName, result: 1_500_000_000_000_000_000n });
      if (functionName === "symbol") return encodeFunctionResult({ abi, functionName, result: "USDC" });
      throw new Error("unexpected call");
    },
  }),
});
const evm = new EvmChainReader({ base: client });

describe("EVM chain reader", () => {
  test("reads a view function and returns JSON-safe data", async () => {
    const balance = await evm.read({
      chain: "base",
      address: TOKEN.toLowerCase(),
      method: "function balanceOf(address) view returns (uint256)",
      args: [HOLDER],
    });
    expect(balance).toBe("1500000000000000000");
    expect(calls.at(-1)!.to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(await evm.read({ chain: "base", address: TOKEN, method: "symbol() view returns (string)", args: [] })).toBe("USDC");
  });

  test("a state-changing function is refused and never sent", async () => {
    const before = calls.length;
    for (const method of [
      "function transfer(address,uint256) returns (bool)",
      "function approve(address,uint256) returns (bool)",
      "function deposit() payable",
    ]) {
      await expect(evm.read({ chain: "base", address: TOKEN, method, args: [HOLDER, "1"].slice(0, method.includes("deposit") ? 0 : 2) })).rejects.toThrow(
        ChainReadRefused,
      );
    }
    expect(calls.length).toBe(before);
  });

  test("bad signatures, bad addresses, wrong argument counts and unknown chains are refused", async () => {
    const read = (over: object) =>
      evm.read({ chain: "base", address: TOKEN, method: "function symbol() view returns (string)", args: [], ...over });
    await expect(read({ method: "DROP TABLE" })).rejects.toThrow(ChainReadRefused);
    await expect(read({ method: "function symbol() view" })).rejects.toThrow(ChainReadRefused);
    await expect(read({ address: "0x123" })).rejects.toThrow(ChainReadRefused);
    await expect(read({ args: ["extra"] })).rejects.toThrow(ChainReadRefused);
    await expect(read({ chain: "rhc" })).rejects.toThrow(ChainReadRefused);
    await expect(new ChainReaders({ base: evm }).read({ chain: "solana", address: "x", method: "y", args: [] })).rejects.toThrow(
      ChainReadRefused,
    );
  });
});

describe("worker tools (§13)", () => {
  const pages: Record<string, string> = { "https://example.com/t": "Holders: 1,200. ".repeat(5000) };
  const fetcher: PageFetcher = {
    fetchText: async (url) => {
      if (url.includes("internal")) throw new FetchBlocked("private_address", "address is not public");
      const text = pages[url];
      if (!text) throw new FetchBlocked("status", "HTTP 404");
      return { url, status: 200, contentType: "text/html", text };
    },
  };
  const tools = new WorkerTools({ fetcher, chain: evm, maxPageChars: 1000 });
  const run = (name: string, input: unknown) => tools.run({ id: "c1", name, input });

  test("the manifest holds only read-only tools", () => {
    expect(WORKER_MANIFEST.tools.map((t) => t.name)).toEqual(["fetch_url", "chain_read"]);
    const { accepted, rejected } = checkToolCalls(WORKER_MANIFEST, [
      { id: "1", name: "fetch_url", arguments: '{"url":"https://example.com/t"}' },
      { id: "2", name: "fetch_url", arguments: '{"url":"javascript:alert(1)"}' },
      { id: "3", name: "send_transaction", arguments: "{}" },
    ]);
    expect(accepted.map((a) => a.id)).toEqual(["1", "2"]); // schema-valid; the fetcher's guard refuses #2 at run time
    expect(rejected).toEqual([{ id: "3", name: "send_transaction", reason: "not_in_manifest" }]);
  });

  test("a fetched page comes back as a data envelope, cut to the size limit", async () => {
    const out = await run("fetch_url", { url: "https://example.com/t" });
    expect(out.envelope).toMatchObject({ from: "tool:fetch_url", kind: "data", schema: "page.v1" });
    const payload = out.envelope.payload as { text: string; truncated: boolean };
    expect(payload.text).toHaveLength(1000);
    expect(payload.truncated).toBe(true);
    expect(out.costUsd6).toBeUndefined();
  });

  test("a refused fetch is reported as data with a short reason, not thrown", async () => {
    const blocked = await run("fetch_url", { url: "http://internal.example/admin" });
    expect(blocked.envelope).toMatchObject({ schema: "page-error.v1", payload: { error: "private_address" } });
    const missing = await run("fetch_url", { url: "https://example.com/nope" });
    expect(missing.envelope.payload).toMatchObject({ error: "status" });
  });

  test("a chain read returns its result; a refused read returns an error envelope", async () => {
    const ok = await run("chain_read", { chain: "base", address: TOKEN, method: "function symbol() view returns (string)", args: [] });
    expect(ok.envelope).toMatchObject({ schema: "chain-read.v1", payload: { result: "USDC" } });
    const bad = await run("chain_read", { chain: "base", address: TOKEN, method: "function transfer(address,uint256) returns (bool)", args: [HOLDER, "1"] });
    expect(bad.envelope).toMatchObject({ schema: "chain-read-error.v1", payload: { error: "read failed" } });
  });

  test("an unknown tool name throws", async () => {
    await expect(run("sign_transaction", {})).rejects.toThrow("no such tool");
  });
});
