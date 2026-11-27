import type { AccountInspector, SolanaAccountKind } from "@jelly/engine";
import type { ChainKey } from "@jelly/shared";
import { getAddress, type PublicClient } from "viem";

/**
 * Real EVM half of wallet detection (§0.7): an EOA has no code, so
 * `evmCodeSize` of 0 means "this is a wallet, not a contract". A read that
 * fails is caught by `detectWallets` itself, which fails closed to "wallet".
 *
 * `solanaAccountKind` is NOT implemented: Solana support (the on-chain
 * program, Phase 8) is a separate, not-yet-started piece of work. It always
 * reports "missing", which `detectWallets` treats as a wallet — the same
 * fail-closed default the design already calls for, so no Solana item is
 * ever under-protected by this standing in for the real lookup.
 */
export class EvmOnlyAccountInspector implements AccountInspector {
  constructor(private readonly clients: Partial<Record<ChainKey, Pick<PublicClient, "getCode">>>) {}

  async evmCodeSize(chain: ChainKey, address: string): Promise<number> {
    const client = this.clients[chain];
    if (!client) throw new Error(`no EVM client configured for chain ${chain}`);
    const code = await client.getCode({ address: getAddress(address) });
    return code ? (code.length - 2) / 2 : 0;
  }

  async solanaAccountKind(_address: string): Promise<SolanaAccountKind> {
    return "missing";
  }
}
