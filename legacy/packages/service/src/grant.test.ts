import { describe, expect, test } from "bun:test";
import { type Hex, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GRANT_TYPES, grantDomain, signGrant } from "./grant";

describe("signGrant", () => {
  const signer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
  const domain = { chainId: 8453, verifyingContract: "0x00000000000000000000000000000000000000fa" as const };
  const unsigned = {
    owner: signer.address,
    keyId: `0x${"11".repeat(32)}` as Hex,
    perJobCapUsd6: 550_000n,
    perDayCapUsd6: 50_000_000n,
    expiresAt: 2_000_000_000n,
    periodCapUsd6: 0n,
    minCoverageBps: 0,
  };

  test("produces a signature the owner's own address can verify, over the exact BalanceVault struct", async () => {
    const grant = await signGrant(signer, domain, unsigned);
    expect(grant).toMatchObject(unsigned);
    const ok = await verifyTypedData({
      address: signer.address,
      domain: grantDomain(domain),
      types: GRANT_TYPES,
      primaryType: "SpendGrant",
      message: unsigned,
      signature: grant.signature,
    });
    expect(ok).toBe(true);
  });

  test("a signature over different grant fields does not verify", async () => {
    const grant = await signGrant(signer, domain, unsigned);
    const ok = await verifyTypedData({
      address: signer.address,
      domain: grantDomain(domain),
      types: GRANT_TYPES,
      primaryType: "SpendGrant",
      message: { ...unsigned, perJobCapUsd6: 1n },
      signature: grant.signature,
    });
    expect(ok).toBe(false);
  });

  test("the domain name and version match the BalanceVault contract's own EIP712(...) constructor", () => {
    expect(grantDomain(domain)).toMatchObject({ name: "JellySwarm Vault", version: "1" });
  });
});
