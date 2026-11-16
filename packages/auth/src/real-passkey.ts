import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResult, PasskeyVerifier, RegistrationResult } from "./passkey";

/** Real WebAuthn ceremony verification, backed by @simplewebauthn/server. */
export class RealPasskeyVerifier implements PasskeyVerifier {
  async verifyRegistration(response: unknown, expectedChallenge: string, origin: string, rpId: string): Promise<RegistrationResult> {
    const result = await verifyRegistrationResponse({
      // @simplewebauthn/server validates the shape itself; a malformed response fails verification, not this cast.
      response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
    });
    if (!result.verified) throw new Error("passkey registration could not be verified");
    const { credential } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: credential.publicKey,
      signCount: credential.counter,
      ...(credential.transports ? { transports: credential.transports } : {}),
    };
  }

  async verifyAuthentication(
    response: unknown,
    credential: { credentialId: string; publicKey: Uint8Array; signCount: number },
    expectedChallenge: string,
    origin: string,
    rpId: string,
  ): Promise<AuthenticationResult> {
    const result = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: { id: credential.credentialId, publicKey: new Uint8Array(credential.publicKey), counter: credential.signCount },
    });
    if (!result.verified) throw new Error("passkey authentication could not be verified");
    return { credentialId: credential.credentialId, signCount: result.authenticationInfo.newCounter };
  }
}
