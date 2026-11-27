import { describe, expect, test } from "bun:test";
import { RealPasskeyVerifier } from "./real-passkey";

/**
 * A full WebAuthn ceremony needs a browser or a virtual authenticator to
 * produce (per the design note in passkey.ts); what's checked here is the
 * seam itself: @simplewebauthn/server is wired in correctly and this class
 * fails closed on anything that isn't a genuine, correctly-signed ceremony
 * response, rather than silently accepting it.
 */
describe("RealPasskeyVerifier", () => {
  const verifier = new RealPasskeyVerifier();

  test("refuses a registration response that is not a real WebAuthn ceremony", async () => {
    await expect(
      verifier.verifyRegistration({ id: "not-real", rawId: "not-real", type: "public-key", response: {} }, "chal", "https://example.com", "example.com"),
    ).rejects.toThrow();
  });

  test("refuses an authentication response that is not a real WebAuthn ceremony", async () => {
    await expect(
      verifier.verifyAuthentication(
        { id: "not-real", rawId: "not-real", type: "public-key", response: {} },
        { credentialId: "not-real", publicKey: new Uint8Array(32), signCount: 0 },
        "chal",
        "https://example.com",
        "example.com",
      ),
    ).rejects.toThrow();
  });
});
