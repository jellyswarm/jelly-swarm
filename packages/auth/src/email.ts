import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * §10.1 (3) Email magic link. `EmailAuth` only ever sees and stores
 * `HMAC(pepper, lowercase(email))`: the plaintext address is handed to the
 * caller once, to pass to a mailer, and is never written down here (§10.1:
 * "The plaintext is held in memory for the send and never written").
 */
export type IssuedLink = { token: string; tokenHash: string; emailHmac: string; expiresAtMs: number };
export type VerifiedLink = { emailHmac: string };

export class EmailAuth {
  constructor(private readonly pepper: string) {
    if (pepper.length < 16) throw new Error("email pepper is too short");
  }

  emailHmac(email: string): string {
    return createHmac("sha256", this.pepper).update(email.trim().toLowerCase()).digest("base64url");
  }

  /** A fast hash is fine here: the token itself already carries 256 bits of entropy. Public so a store can be keyed by it. */
  hash(token: string): string {
    return createHash("sha256").update(token).digest("base64url");
  }

  /** A fresh single-use token, valid for 15 minutes. The raw `token` is what goes into the emailed link; keep only its hash. */
  issue(email: string, nowMs: number, ttlMs = 15 * 60 * 1000): IssuedLink {
    const token = randomBytes(32).toString("base64url");
    return { token, tokenHash: this.hash(token), emailHmac: this.emailHmac(email), expiresAtMs: nowMs + ttlMs };
  }

  /** Constant-time compares the clicked token's hash against the stored one. */
  matches(token: string, storedTokenHash: string): boolean {
    const a = Buffer.from(this.hash(token));
    const b = Buffer.from(storedTokenHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
