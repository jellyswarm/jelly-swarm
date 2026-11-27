import { z } from "zod";

/**
 * Settlement chains (§ "Chains"). Any value the build doc marks as a day-1
 * check carries `confirmed: false` and is tracked in docs/day1.md. Code that
 * moves money must call `requireConfirmed` and so refuses to run on a chain
 * whose facts are still unverified.
 */
export const ChainKey = z.enum(["base", "rhc", "solana", "hyperevm", "elysium"]);
export type ChainKey = z.infer<typeof ChainKey>;

export type ChainInfo = {
  key: ChainKey;
  kind: "evm" | "solana";
  /** EVM chain id; null for Solana or when not yet known. */
  chainId: number | null;
  /** x402 / CAIP-2 network id; null when not yet known. */
  caip2: string | null;
  asset: { symbol: "USDC" | "USDG"; address: string; decimals: 6 } | null;
  phase: "launch" | "picket";
  confirmed: boolean;
  /** What still has to be checked, in plain words. */
  unconfirmed: string[];
};

export const CHAINS: Record<ChainKey, ChainInfo> = {
  base: {
    key: "base",
    kind: "evm",
    chainId: 8453,
    caip2: "eip155:8453",
    asset: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    phase: "launch",
    confirmed: true,
    unconfirmed: [],
  },
  rhc: {
    key: "rhc",
    kind: "evm",
    chainId: 4663,
    caip2: "eip155:4663",
    asset: null,
    phase: "launch",
    confirmed: false,
    unconfirmed: ["chain id 4663 (from studio notes)", "USDG address, decimals, EIP-3009/2612 support"],
  },
  solana: {
    key: "solana",
    kind: "solana",
    chainId: null,
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    phase: "launch",
    confirmed: true,
    unconfirmed: [],
  },
  hyperevm: {
    key: "hyperevm",
    kind: "evm",
    chainId: 999,
    caip2: "eip155:999",
    asset: null,
    phase: "picket",
    confirmed: false,
    unconfirmed: ["stablecoin asset", "x402 path"],
  },
  elysium: {
    key: "elysium",
    kind: "evm",
    chainId: null,
    caip2: null,
    asset: null,
    phase: "picket",
    confirmed: false,
    unconfirmed: ["chain id", "stablecoins", "x402 path"],
  },
};

export class UnconfirmedChainError extends Error {
  constructor(readonly chain: ChainKey, readonly missing: string[]) {
    super(`chain ${chain} has unconfirmed day-1 facts: ${missing.join("; ")}`);
    this.name = "UnconfirmedChainError";
  }
}

/** Returns the chain with a non-null asset and chain facts, or throws. */
export function requireConfirmed(key: ChainKey): ChainInfo & { asset: NonNullable<ChainInfo["asset"]> } {
  const c = CHAINS[key];
  if (!c.confirmed || !c.asset) throw new UnconfirmedChainError(key, c.unconfirmed);
  return c as ChainInfo & { asset: NonNullable<ChainInfo["asset"]> };
}
