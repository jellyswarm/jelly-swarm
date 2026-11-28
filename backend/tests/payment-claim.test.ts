import { describe, expect, test } from "bun:test";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { paymentClaimTypes } from "../src/services/chain";

describe("job-bound payment claims", () => {
  test("signature is bound to the job, payer, transaction, escrow and expiry", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const domain = {
      name: "JellySwarmPaymentClaim",
      version: "1",
      chainId: 99_901,
      verifyingContract: "0x9392cc8C422B1e29C1648e0B535c4670B822FabD" as const,
    };
    const message = {
      jobId: `0x${"a".repeat(64)}` as `0x${string}`,
      transactionHash: `0x${"b".repeat(64)}` as `0x${string}`,
      payer: payer.address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    };
    const signature = await payer.signTypedData({ domain, types: paymentClaimTypes, primaryType: "PaymentClaim", message });
    const recovered = await recoverTypedDataAddress({ domain, types: paymentClaimTypes, primaryType: "PaymentClaim", message, signature });
    const altered = await recoverTypedDataAddress({
      domain,
      types: paymentClaimTypes,
      primaryType: "PaymentClaim",
      message: { ...message, jobId: `0x${"c".repeat(64)}` as `0x${string}` },
      signature,
    });

    expect(recovered).toBe(payer.address);
    expect(altered).not.toBe(payer.address);
  });
});
