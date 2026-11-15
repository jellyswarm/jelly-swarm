import type { ChainRead } from "@jelly/engine";
import type { ChainKey } from "@jelly/shared";
import { type AbiFunction, type PublicClient, getAddress, parseAbiItem } from "viem";

/**
 * Read-only chain access (§3.4 step 3). The worker cites a read; the checker
 * re-runs the same read at the latest block and compares.
 */
export interface ChainReader {
  /** Returns the read's result as JSON-safe data (bigints as decimal strings). */
  read(req: ChainRead): Promise<unknown>;
}

export class ChainReadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainReadRefused";
  }
}

const jsonSafe = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(jsonSafe) : v;

/**
 * EVM reader. `method` is a full human-readable function signature, e.g.
 * "function balanceOf(address) view returns (uint256)". Only view and pure
 * functions are accepted, and the call is an eth_call: it cannot change state.
 */
export class EvmChainReader implements ChainReader {
  constructor(private readonly clients: Partial<Record<ChainKey, Pick<PublicClient, "readContract">>>) {}

  async read(req: ChainRead): Promise<unknown> {
    const client = this.clients[req.chain];
    if (!client) throw new ChainReadRefused(`no reader configured for chain ${req.chain}`);

    let fn: AbiFunction;
    try {
      const item = parseAbiItem(req.method.trim().startsWith("function ") ? req.method : `function ${req.method}`);
      if (item.type !== "function") throw new Error("not a function");
      fn = item;
    } catch {
      throw new ChainReadRefused("method must be a function signature such as: function totalSupply() view returns (uint256)");
    }
    if (fn.stateMutability !== "view" && fn.stateMutability !== "pure") {
      throw new ChainReadRefused("only view and pure functions can be read");
    }
    if (fn.outputs.length === 0) throw new ChainReadRefused("the function must declare what it returns");
    if (req.args.length !== fn.inputs.length) throw new ChainReadRefused("wrong number of arguments");

    const args = fn.inputs.map((input, i) => {
      const raw = req.args[i];
      // JSON has no bigint: integer arguments arrive as numbers or decimal strings.
      if (/^u?int\d*$/.test(input.type) && (typeof raw === "string" || typeof raw === "number")) return BigInt(raw);
      return raw;
    });

    let address: `0x${string}`;
    try {
      address = getAddress(req.address);
    } catch {
      throw new ChainReadRefused("not a valid contract address");
    }
    const result = await client.readContract({ address, abi: [fn], functionName: fn.name, args });
    return jsonSafe(result);
  }
}

/** Routes each read to the reader for its chain. A chain with no reader fails closed. */
export class ChainReaders implements ChainReader {
  constructor(private readonly byChain: Partial<Record<ChainKey, ChainReader>>) {}

  read(req: ChainRead): Promise<unknown> {
    const reader = this.byChain[req.chain];
    if (!reader) return Promise.reject(new ChainReadRefused(`no reader configured for chain ${req.chain}`));
    return reader.read(req);
  }
}
