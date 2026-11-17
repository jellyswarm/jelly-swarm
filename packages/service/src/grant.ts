import type { Address, Hex } from "viem";
import type { SignedGrant } from "./escrow";

/**
 * §10.2 `BalanceVault.SpendGrant`'s own EIP-712 struct — field order and types copied straight
 * from `contracts/src/BalanceVault.sol`'s `GRANT_TYPEHASH`. `grantDomain()` matches the
 * contract's `EIP712("JellySwarm Vault", "1")` constructor call.
 */
export const GRANT_TYPES = {
  SpendGrant: [
    { name: "owner", type: "address" },
    { name: "keyId", type: "bytes32" },
    { name: "perJobCapUsd6", type: "uint64" },
    { name: "perDayCapUsd6", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "periodCapUsd6", type: "uint64" },
    { name: "minCoverageBps", type: "uint16" },
  ],
} as const;

export type GrantDomainParams = { chainId: number; verifyingContract: Address };
export const grantDomain = (p: GrantDomainParams) => ({ name: "JellySwarm Vault", version: "1", ...p }) as const;

export interface GrantSigner {
  address: Address;
  signTypedData(args: {
    domain: ReturnType<typeof grantDomain>;
    types: typeof GRANT_TYPES;
    primaryType: "SpendGrant";
    message: Omit<SignedGrant, "signature">;
  }): Promise<Hex>;
}

/** Signs a grant the signer's own address owns — e.g. the studio signing its own free-tier grant once at startup. */
export async function signGrant(
  signer: GrantSigner,
  domain: GrantDomainParams,
  grant: Omit<SignedGrant, "signature">,
): Promise<SignedGrant> {
  const signature = await signer.signTypedData({ domain: grantDomain(domain), types: GRANT_TYPES, primaryType: "SpendGrant", message: grant });
  return { ...grant, signature };
}
