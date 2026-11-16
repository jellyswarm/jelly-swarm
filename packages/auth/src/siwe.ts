import { randomBytes } from "node:crypto";
import { type Address, verifyMessage } from "viem";

/**
 * §10.1 (4) External wallet sign-in, "as in Muster": a plain sign-this-message
 * challenge, not the full SIWE/EIP-4361 field set. A production deployment
 * that must interoperate with SIWE-aware wallets can parse/build the full
 * message format on top of this; the signature check itself is the same
 * either way.
 */
export type SiweChallenge = { nonce: string; message: string; expiresAtMs: number };

export class SiweAuth {
  constructor(private readonly domain: string) {}

  /** The message the wallet will be asked to sign, bound to this domain and a fresh nonce. */
  issue(address: Address, chain: string, nowMs: number, ttlMs = 5 * 60 * 1000): SiweChallenge {
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date(nowMs).toISOString();
    const message = [
      `${this.domain} wants you to sign in with your ${chain} account:`,
      address,
      "",
      "Sign in to JellySwarm.",
      "",
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
    ].join("\n");
    return { nonce, message, expiresAtMs: nowMs + ttlMs };
  }

  /** Verifies the wallet's signature over exactly the issued message. */
  async verify(address: Address, message: string, signature: `0x${string}`, challenge: SiweChallenge, nowMs: number): Promise<boolean> {
    if (nowMs >= challenge.expiresAtMs) return false;
    if (message !== challenge.message) return false;
    return verifyMessage({ address, message, signature }).catch(() => false);
  }
}
