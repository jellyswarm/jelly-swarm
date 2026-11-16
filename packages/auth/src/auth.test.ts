import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  AuthError,
  AuthService,
  type AuthenticationResult,
  DeviceAuth,
  EmailAuth,
  MemoryAccountStore,
  MemorySessionStore,
  type PasskeyVerifier,
  type RegistrationResult,
  SiweAuth,
} from "./index";

const wallet = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

describe("DeviceAuth (§10.1 anonymous)", () => {
  test("a freshly issued cookie verifies, within its lifetime", () => {
    const d = new DeviceAuth("a-long-enough-secret-value");
    const { deviceId, cookie } = d.issue(1000);
    expect(d.verify(cookie, 1000)).toEqual({ deviceId, expiresAtMs: 1000 + 365 * 24 * 3600 * 1000 });
    expect(d.verify(cookie, 1000 + 365 * 24 * 3600 * 1000)).toBeNull(); // exactly expired
  });

  test("a forged, tampered or wrong-secret cookie never verifies", () => {
    const d = new DeviceAuth("a-long-enough-secret-value");
    const other2 = new DeviceAuth("a-different-long-secret!!");
    const { cookie, deviceId } = d.issue(1000);
    expect(d.verify("not.a.cookie", 1000)).toBeNull();
    expect(d.verify(`${deviceId}.99999999999999.forged-signature`, 1000)).toBeNull();
    expect(other2.verify(cookie, 1000)).toBeNull();
    // Tampering with the claimed expiry invalidates the signature too.
    const [id, exp, sig] = cookie.split(".");
    expect(d.verify(`${id}.${Number(exp) + 1}.${sig}`, 1000)).toBeNull();
  });

  test("rejects an unreasonably short secret", () => {
    expect(() => new DeviceAuth("short")).toThrow();
  });
});

describe("EmailAuth (§10.1 email link)", () => {
  test("only the HMAC is ever produced for storage; the same email always hashes the same, case-insensitively", () => {
    const e = new EmailAuth("a-long-enough-pepper-value");
    expect(e.emailHmac("Alice@Example.com")).toBe(e.emailHmac("alice@example.com "));
    expect(e.emailHmac("alice@example.com")).not.toBe(e.emailHmac("bob@example.com"));
  });

  test("a token matches only its own hash", () => {
    const e = new EmailAuth("a-long-enough-pepper-value");
    const issued = e.issue("alice@example.com", 1000);
    expect(e.matches(issued.token, issued.tokenHash)).toBe(true);
    expect(e.matches("some-other-token", issued.tokenHash)).toBe(false);
  });
});

describe("SiweAuth (§10.1 external wallet)", () => {
  test("a message signed by the right address, over the exact issued text, verifies", async () => {
    const siwe = new SiweAuth("jellyswarm.example");
    const challenge = siwe.issue(wallet.address, "base", 1000);
    const signature = await wallet.signMessage({ message: challenge.message });
    expect(await siwe.verify(wallet.address, challenge.message, signature, challenge, 1000)).toBe(true);
  });

  test("a different signer, a tampered message, or an expired challenge all fail", async () => {
    const siwe = new SiweAuth("jellyswarm.example");
    const challenge = siwe.issue(wallet.address, "base", 1000);
    const signature = await wallet.signMessage({ message: challenge.message });
    expect(await siwe.verify(wallet.address, challenge.message, await other.signMessage({ message: challenge.message }), challenge, 1000)).toBe(
      false,
    );
    expect(await siwe.verify(wallet.address, `${challenge.message}\nextra`, signature, challenge, 1000)).toBe(false);
    expect(await siwe.verify(wallet.address, challenge.message, signature, challenge, challenge.expiresAtMs)).toBe(false);
  });
});

// ───────────────────────── AuthService ─────────────────────────

function fakeVerifier(): PasskeyVerifier & { registered: Map<string, { publicKey: Uint8Array; signCount: number }> } {
  const registered = new Map<string, { publicKey: Uint8Array; signCount: number }>();
  return {
    registered,
    verifyRegistration: async (response, expectedChallenge): Promise<RegistrationResult> => {
      const r = response as { credentialId: string; challenge: string; signCount?: number };
      if (r.challenge !== expectedChallenge) throw new Error("challenge mismatch");
      const publicKey = new Uint8Array([1, 2, 3]);
      registered.set(r.credentialId, { publicKey, signCount: r.signCount ?? 0 });
      return { credentialId: r.credentialId, publicKey, signCount: r.signCount ?? 0 };
    },
    verifyAuthentication: async (response, credential, expectedChallenge): Promise<AuthenticationResult> => {
      const r = response as { credentialId: string; challenge: string; signCount: number };
      if (r.challenge !== expectedChallenge) throw new Error("challenge mismatch");
      if (r.credentialId !== credential.credentialId) throw new Error("wrong credential");
      return { credentialId: r.credentialId, signCount: r.signCount };
    },
  };
}

function setup() {
  const clock = { now: 1_800_000_000_000 };
  const verifier = fakeVerifier();
  const auth = new AuthService({
    accounts: new MemoryAccountStore(() => clock.now),
    sessions: new MemorySessionStore(),
    passkeyVerifier: verifier,
    deviceSecret: "a-long-enough-secret-value",
    emailPepper: "a-long-enough-pepper-value",
    siweDomain: "jellyswarm.example",
    rpId: "jellyswarm.example",
    origin: "https://jellyswarm.example",
    now: () => clock.now,
  });
  return { clock, auth, verifier };
}

describe("AuthService: anonymous device (§10.1)", () => {
  test("a fresh visit issues a cookie; the account is created lazily, not at sign-in", async () => {
    const { auth } = setup();
    const { deviceId, cookie, isNew } = auth.startAnonymous(undefined);
    expect(isNew).toBe(true);
    expect(auth.startAnonymous(cookie)).toMatchObject({ deviceId, isNew: false });
    const accountId = await auth.ensureAccountForDevice(deviceId);
    expect(await auth.ensureAccountForDevice(deviceId)).toBe(accountId); // same device, same account, every time
  });
});

describe("AuthService: passkey (§10.1, §10.2)", () => {
  test("registration creates an account and signs it in; the same credential cannot register twice", async () => {
    const { auth } = setup();
    const { challenge } = auth.beginPasskeyRegistration();
    const { accountId, session } = await auth.completeRegistration({ credentialId: "cred-1", challenge }, challenge);
    expect(session.accountId).toBe(accountId);

    const { challenge: challenge2 } = auth.beginPasskeyRegistration();
    await expect(auth.completeRegistration({ credentialId: "cred-1", challenge: challenge2 }, challenge2)).rejects.toThrow(AuthError);
  });

  test("a challenge is single-use and expires", async () => {
    const { auth, clock } = setup();
    const { challenge } = auth.beginPasskeyRegistration();
    await auth.completeRegistration({ credentialId: "cred-a", challenge }, challenge);
    await expect(auth.completeRegistration({ credentialId: "cred-b", challenge }, challenge)).rejects.toThrow(AuthError);

    const { challenge: fresh } = auth.beginPasskeyRegistration();
    clock.now += 3 * 60 * 1000;
    await expect(auth.completeRegistration({ credentialId: "cred-c", challenge: fresh }, fresh)).rejects.toThrow(AuthError);
  });

  test("authentication signs back into the same account, and flags a signCount that did not advance", async () => {
    const { auth } = setup();
    const reg = auth.beginPasskeyRegistration();
    const { accountId } = await auth.completeRegistration({ credentialId: "cred-1", challenge: reg.challenge, signCount: 1 }, reg.challenge);

    const good = auth.beginPasskeyAuthentication();
    const authed = await auth.completeAuthentication("cred-1", { credentialId: "cred-1", challenge: good.challenge, signCount: 2 }, good.challenge);
    expect(authed).toMatchObject({ accountId, possibleClone: false });

    const suspicious = auth.beginPasskeyAuthentication();
    const flagged = await auth.completeAuthentication(
      "cred-1",
      { credentialId: "cred-1", challenge: suspicious.challenge, signCount: 2 },
      suspicious.challenge,
    );
    expect(flagged.possibleClone).toBe(true); // signCount did not advance past the last accepted value
  });

  test("authenticating an unknown credential is refused", async () => {
    const { auth } = setup();
    const { challenge } = auth.beginPasskeyAuthentication();
    await expect(auth.completeAuthentication("never-registered", { credentialId: "never-registered", challenge }, challenge)).rejects.toThrow(
      AuthError,
    );
  });
});

describe("AuthService: email link (§10.1)", () => {
  test("clicking the link signs in; a second click of the same link is refused", async () => {
    const { auth } = setup();
    const { token } = auth.requestEmailLink("alice@example.com");
    const { accountId } = await auth.verifyEmailLink(token);
    await expect(auth.verifyEmailLink(token)).rejects.toThrow(AuthError);

    // The same email later resolves to the same account (not a new one).
    const { token: token2 } = auth.requestEmailLink("ALICE@example.com");
    expect((await auth.verifyEmailLink(token2)).accountId).toBe(accountId);
  });

  test("the link expires after 15 minutes", async () => {
    const { auth, clock } = setup();
    const { token } = auth.requestEmailLink("alice@example.com");
    clock.now += 16 * 60 * 1000;
    await expect(auth.verifyEmailLink(token)).rejects.toThrow(AuthError);
  });

  test("a made-up token is refused", async () => {
    const { auth } = setup();
    await expect(auth.verifyEmailLink("not-a-real-token")).rejects.toThrow(AuthError);
  });
});

describe("AuthService: external wallet (§10.1)", () => {
  test("a verified signature signs in; the same wallet later resolves to the same account", async () => {
    const { auth } = setup();
    const challenge = auth.issueSiweChallenge(wallet.address, "base");
    const signature = await wallet.signMessage({ message: challenge.message });
    const { accountId } = await auth.verifySiwe(wallet.address, challenge.message, signature, challenge.nonce);

    const challenge2 = auth.issueSiweChallenge(wallet.address, "base");
    const signature2 = await wallet.signMessage({ message: challenge2.message });
    expect((await auth.verifySiwe(wallet.address, challenge2.message, signature2, challenge2.nonce)).accountId).toBe(accountId);
  });

  test("a signature from a different wallet is refused", async () => {
    const { auth } = setup();
    const challenge = auth.issueSiweChallenge(wallet.address, "base");
    const signature = await other.signMessage({ message: challenge.message });
    await expect(auth.verifySiwe(wallet.address, challenge.message, signature, challenge.nonce)).rejects.toThrow(AuthError);
  });
});

describe("AuthService: identity merge (§10.1 'only with both proofs in-session')", () => {
  test("linking a wallet requires a live session and a fresh signature; it is then attached to that session's account", async () => {
    const { auth } = setup();
    const reg = auth.beginPasskeyRegistration();
    const { accountId, session } = await auth.completeRegistration({ credentialId: "cred-1", challenge: reg.challenge }, reg.challenge);

    const challenge = auth.issueSiweChallenge(wallet.address, "base");
    const signature = await wallet.signMessage({ message: challenge.message });
    await auth.linkWalletToSession(session.id, wallet.address, challenge.message, signature, challenge.nonce);

    // The wallet now signs in to the SAME account, not a fresh one.
    const challenge2 = auth.issueSiweChallenge(wallet.address, "base");
    const signature2 = await wallet.signMessage({ message: challenge2.message });
    expect((await auth.verifySiwe(wallet.address, challenge2.message, signature2, challenge2.nonce)).accountId).toBe(accountId);
  });

  test("linking refuses without a live session, even with a perfectly valid signature", async () => {
    const { auth } = setup();
    const challenge = auth.issueSiweChallenge(wallet.address, "base");
    const signature = await wallet.signMessage({ message: challenge.message });
    await expect(auth.linkWalletToSession("not-a-real-session", wallet.address, challenge.message, signature, challenge.nonce)).rejects.toThrow(
      AuthError,
    );
  });

  test("linking an identity that already belongs to a different account is refused, not silently merged", async () => {
    const { auth } = setup();
    const challengeA = auth.issueSiweChallenge(wallet.address, "base");
    await auth.verifySiwe(wallet.address, challengeA.message, await wallet.signMessage({ message: challengeA.message }), challengeA.nonce);

    const reg = auth.beginPasskeyRegistration();
    const { session } = await auth.completeRegistration({ credentialId: "cred-2", challenge: reg.challenge }, reg.challenge);
    const challengeB = auth.issueSiweChallenge(wallet.address, "base");
    const signatureB = await wallet.signMessage({ message: challengeB.message });
    await expect(auth.linkWalletToSession(session.id, wallet.address, challengeB.message, signatureB, challengeB.nonce)).rejects.toThrow(
      AuthError,
    );
  });

  test("linking an email requires its own fresh click, not just knowing the address", async () => {
    const { auth } = setup();
    const reg = auth.beginPasskeyRegistration();
    const { session } = await auth.completeRegistration({ credentialId: "cred-3", challenge: reg.challenge }, reg.challenge);
    const { token } = auth.requestEmailLink("alice@example.com");
    await auth.linkEmailToSession(session.id, token);
    await expect(auth.linkEmailToSession(session.id, token)).rejects.toThrow(AuthError); // the same link cannot be replayed
  });
});
