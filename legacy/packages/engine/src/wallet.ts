import type { ChainKey } from "@jelly/shared";
import type { Item, JobSpec } from "./spec";

/**
 * §0.7 wallet detection. A list of someone's wallets reveals what they own,
 * so any job with a wallet address is forced onto the Sealed tier and TEE
 * hosts. A wallet is an EOA on EVM (an address with no code), or a Solana
 * account that is neither a program nor a mint.
 */
export type SolanaAccountKind = "wallet" | "program" | "mint" | "other" | "missing";

/** Read-only chain lookups. Implemented with viem and a Solana RPC in apps; mocked in tests. */
export interface AccountInspector {
  evmCodeSize(chain: ChainKey, address: string): Promise<number>;
  solanaAccountKind(address: string): Promise<SolanaAccountKind>;
}

export type WalletDetection = { walletJob: boolean; walletItems: number[] };

/**
 * Finds the items that are wallets. Fails closed: if a lookup errors, or a
 * Solana address has no account yet, the item is treated as a wallet.
 */
export async function detectWallets(
  items: readonly Item[],
  inspector: AccountInspector,
  defaultEvmChain: ChainKey,
): Promise<WalletDetection> {
  const flags = await Promise.all(
    items.map(async (item): Promise<boolean> => {
      try {
        if (item.kind === "evm_address") {
          return (await inspector.evmCodeSize(item.chain ?? defaultEvmChain, item.raw)) === 0;
        }
        if (item.kind === "solana_address") {
          const kind = await inspector.solanaAccountKind(item.raw);
          return kind === "wallet" || kind === "missing";
        }
        return false;
      } catch {
        return true;
      }
    }),
  );
  const walletItems = flags.flatMap((isWallet, i) => (isWallet ? [i] : []));
  return { walletJob: walletItems.length > 0, walletItems };
}

/** Applies the wallet rule to a spec: a wallet job is always Sealed, whatever tier was asked for. */
export async function applyWalletRule(
  spec: JobSpec,
  inspector: AccountInspector,
  defaultEvmChain: ChainKey,
): Promise<{ spec: JobSpec; walletJob: boolean; walletItems: number[]; tierForced: boolean }> {
  const { walletJob, walletItems } = await detectWallets(spec.items, inspector, defaultEvmChain);
  if (!walletJob || spec.tier === "sealed") return { spec, walletJob, walletItems, tierForced: false };
  return { spec: { ...spec, tier: "sealed" }, walletJob, walletItems, tierForced: true };
}
