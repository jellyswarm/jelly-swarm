import { randomBytes } from "node:crypto";

/**
 * §10.1 (2) and §10.2: WebAuthn (passkey) sign-in and the embedded wallet
 * it controls. The actual cryptographic ceremony — parsing an attestation
 * or assertion object, checking its COSE key, its signature, its client
 * data JSON — needs a conformance-tested library and a real authenticator
 * to test against; neither is available here. `PasskeyVerifier` is the seam:
 * `AuthService` only ever calls it, never touches ceremony bytes itself, so
 * swapping in a real verifier (e.g. `@simplewebauthn/server`) changes
 * nothing else. Tests exercise `AuthService` against a fake verifier.
 */
export type RegistrationResult = { credentialId: string; publicKey: Uint8Array; signCount: number; transports?: string[] };
export type AuthenticationResult = { credentialId: string; signCount: number };

export interface PasskeyVerifier {
  verifyRegistration(response: unknown, expectedChallenge: string, origin: string, rpId: string): Promise<RegistrationResult>;
  verifyAuthentication(
    response: unknown,
    credential: { credentialId: string; publicKey: Uint8Array; signCount: number },
    expectedChallenge: string,
    origin: string,
    rpId: string,
  ): Promise<AuthenticationResult>;
}

export type PasskeyChallenge = { challenge: string; expiresAtMs: number };

/** Issues and checks the random challenge a registration or authentication ceremony signs over. */
export class PasskeyChallenges {
  issue(nowMs: number, ttlMs = 2 * 60 * 1000): PasskeyChallenge {
    return { challenge: randomBytes(32).toString("base64url"), expiresAtMs: nowMs + ttlMs };
  }

  isLive(challenge: PasskeyChallenge, nowMs: number): boolean {
    return nowMs < challenge.expiresAtMs;
  }
}
