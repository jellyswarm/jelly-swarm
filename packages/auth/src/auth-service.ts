import type { Address } from "viem";
import { COPY } from "./copy";
import { DeviceAuth } from "./device";
import { EmailAuth } from "./email";
import { type AuthenticationResult, type PasskeyChallenge, PasskeyChallenges, type PasskeyVerifier, type RegistrationResult } from "./passkey";
import { DEFAULT_SESSION_TTL_MS, type Session, type SessionStore, isLive } from "./session";
import { SiweAuth, type SiweChallenge } from "./siwe";
import type { AccountStore } from "./store";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthDeps = {
  accounts: AccountStore;
  sessions: SessionStore;
  passkeyVerifier: PasskeyVerifier;
  deviceSecret: string;
  emailPepper: string;
  siweDomain: string;
  rpId: string;
  origin: string;
  now?: () => number;
};

type Pending<T> = T & { used: boolean };

/**
 * §10.1-10.1.4, §10.4: every sign-in path resolves to one `accounts` row.
 * "Identities merge only when a signed-in session proves both of them.
 * There is no merge by email lookup" — every `link*` method below requires
 * an already-live session and a *fresh* proof of the identity being added;
 * it never merges by matching a stored identifier alone.
 */
export class AuthService {
  private readonly device: DeviceAuth;
  private readonly email: EmailAuth;
  private readonly siwe: SiweAuth;
  private readonly passkeyChallenges = new PasskeyChallenges();
  private readonly now: () => number;

  private readonly pendingEmailLinks = new Map<string, Pending<{ emailHmac: string; expiresAtMs: number }>>();
  private readonly pendingPasskeyChallenges = new Map<string, Pending<PasskeyChallenge>>();
  private readonly pendingSiwe = new Map<string, Pending<SiweChallenge & { address: Address; chain: string }>>();

  constructor(private readonly deps: AuthDeps) {
    this.device = new DeviceAuth(deps.deviceSecret);
    this.email = new EmailAuth(deps.emailPepper);
    this.siwe = new SiweAuth(deps.siweDomain);
    this.now = deps.now ?? Date.now;
  }

  private async session(accountId: string, deviceId?: string): Promise<Session> {
    return this.deps.sessions.create(accountId, deviceId, this.now(), DEFAULT_SESSION_TTL_MS);
  }

  async currentSession(sessionId: string): Promise<Session> {
    const session = await this.deps.sessions.get(sessionId);
    if (!isLive(session, this.now())) throw new AuthError(COPY.sessionExpired);
    return session;
  }

  // ───────────────────────── (1) anonymous device ─────────────────────────

  /** Verifies an existing device cookie, or issues a fresh one if there is none or it is no longer good. */
  startAnonymous(cookie: string | undefined): { deviceId: string; cookie: string; isNew: boolean } {
    if (cookie) {
      const token = this.device.verify(cookie, this.now());
      if (token) return { deviceId: token.deviceId, cookie, isNew: false };
    }
    const issued = this.device.issue(this.now());
    return { ...issued, isNew: true };
  }

  /** The account is created lazily on first job (§10.1); this is that moment. */
  async ensureAccountForDevice(deviceId: string): Promise<string> {
    const existing = await this.deps.accounts.getDevice(deviceId);
    if (existing?.accountId) return existing.accountId;
    const account = await this.deps.accounts.createAccount();
    await this.deps.accounts.putDevice({ id: deviceId, accountId: account.id, powPenaltyBits: existing?.powPenaltyBits ?? 0 });
    return account.id;
  }

  // ───────────────────────── (2) passkey ─────────────────────────

  beginPasskeyRegistration(): { challenge: string } {
    const c = this.passkeyChallenges.issue(this.now());
    this.pendingPasskeyChallenges.set(c.challenge, { ...c, used: false });
    return { challenge: c.challenge };
  }

  beginPasskeyAuthentication(): { challenge: string } {
    return this.beginPasskeyRegistration(); // same shape; a resident credential means no credential list to send
  }

  private takeChallenge(challenge: string): void {
    const c = this.pendingPasskeyChallenges.get(challenge);
    if (!c || c.used || !this.passkeyChallenges.isLive(c, this.now())) throw new AuthError(COPY.passkeyChallengeExpired);
    c.used = true;
  }

  /** New passkey, new or existing account. Creates a session either way. */
  async completeRegistration(response: unknown, challenge: string, existingAccountId?: string): Promise<{ accountId: string; session: Session }> {
    this.takeChallenge(challenge);
    const result: RegistrationResult = await this.deps.passkeyVerifier.verifyRegistration(response, challenge, this.deps.origin, this.deps.rpId);
    if (await this.deps.accounts.getPasskey(result.credentialId)) throw new AuthError(COPY.identityTaken);

    const accountId = existingAccountId ?? (await this.deps.accounts.createAccount()).id;
    await this.deps.accounts.putPasskey({
      credentialId: result.credentialId,
      accountId,
      publicKey: result.publicKey,
      signCount: result.signCount,
      ...(result.transports ? { transports: result.transports } : {}),
    });
    return { accountId, session: await this.session(accountId) };
  }

  /**
   * `credentialId` comes straight off the WebAuthn response's own `id`
   * field (plain data, not part of the cryptographic ceremony) so the
   * stored credential can be looked up before verification.
   */
  async completeAuthentication(
    credentialId: string,
    response: unknown,
    challenge: string,
  ): Promise<{ accountId: string; session: Session; possibleClone: boolean }> {
    this.takeChallenge(challenge);
    const stored = await this.deps.accounts.getPasskey(credentialId);
    if (!stored) throw new AuthError(COPY.identityTaken);

    const result: AuthenticationResult = await this.deps.passkeyVerifier.verifyAuthentication(
      response,
      stored,
      challenge,
      this.deps.origin,
      this.deps.rpId,
    );
    // §10.2: a signature count that did not advance can mean a cloned authenticator.
    const possibleClone = result.signCount <= stored.signCount && stored.signCount > 0;
    await this.deps.accounts.setPasskeySignCount(credentialId, Math.max(result.signCount, stored.signCount));
    return { accountId: stored.accountId, session: await this.session(stored.accountId), possibleClone };
  }

  // ───────────────────────── (3) email link ─────────────────────────

  /** Returns the raw token for the caller's mailer to send, and the HMAC for its own records; never the plaintext address. */
  requestEmailLink(email: string): { token: string; emailHmac: string } {
    const issued = this.email.issue(email, this.now());
    this.pendingEmailLinks.set(issued.tokenHash, { emailHmac: issued.emailHmac, expiresAtMs: issued.expiresAtMs, used: false });
    return { token: issued.token, emailHmac: issued.emailHmac };
  }

  /** Resolves (or creates) the account for this email and signs it in. */
  async verifyEmailLink(token: string): Promise<{ accountId: string; session: Session }> {
    const tokenHash = this.email.hash(token);
    const pending = this.pendingEmailLinks.get(tokenHash);
    if (!pending || pending.used || this.now() >= pending.expiresAtMs) throw new AuthError(COPY.emailLinkExpired);
    pending.used = true;

    const existing = await this.deps.accounts.getEmailLogin(pending.emailHmac);
    const accountId = existing?.accountId ?? (await this.deps.accounts.createAccount()).id;
    if (!existing) await this.deps.accounts.putEmailLogin({ emailHmac: pending.emailHmac, accountId });
    return { accountId, session: await this.session(accountId) };
  }

  // ───────────────────────── (4) external wallet (SIWE) ─────────────────────────

  issueSiweChallenge(address: Address, chain: string): SiweChallenge {
    const c = this.siwe.issue(address, chain, this.now());
    this.pendingSiwe.set(c.nonce, { ...c, address, chain, used: false });
    return c;
  }

  async verifySiwe(address: Address, message: string, signature: `0x${string}`, nonce: string): Promise<{ accountId: string; session: Session }> {
    const pending = this.pendingSiwe.get(nonce);
    if (!pending || pending.used || pending.address.toLowerCase() !== address.toLowerCase()) throw new AuthError(COPY.siweMessageExpired);
    const ok = await this.siwe.verify(address, message, signature, pending, this.now());
    if (!ok) throw new AuthError(COPY.siweMessageExpired);
    pending.used = true;

    const existing = await this.deps.accounts.getWallet(pending.chain, address);
    const accountId = existing?.accountId ?? (await this.deps.accounts.createAccount()).id;
    if (!existing) await this.deps.accounts.putWallet({ address, chain: pending.chain, accountId, kind: "external" });
    return { accountId, session: await this.session(accountId) };
  }

  // ───────────────────────── identity merge (§10.1 "merge only with both proofs") ─────────────────────────

  /** Attaches a freshly-proven wallet to the account the current session already belongs to. */
  async linkWalletToSession(sessionId: string, address: Address, message: string, signature: `0x${string}`, nonce: string): Promise<void> {
    const session = await this.currentSession(sessionId);
    const pending = this.pendingSiwe.get(nonce);
    if (!pending || pending.used || pending.address.toLowerCase() !== address.toLowerCase()) throw new AuthError(COPY.siweMessageExpired);
    const existing = await this.deps.accounts.getWallet(pending.chain, address);
    if (existing && existing.accountId !== session.accountId) throw new AuthError(COPY.identityTaken);
    const ok = await this.siwe.verify(address, message, signature, pending, this.now());
    if (!ok) throw new AuthError(COPY.siweMessageExpired);
    pending.used = true;
    if (!existing) await this.deps.accounts.putWallet({ address, chain: pending.chain, accountId: session.accountId, kind: "external" });
  }

  /** Attaches a freshly-clicked email link to the account the current session already belongs to. */
  async linkEmailToSession(sessionId: string, token: string): Promise<void> {
    const session = await this.currentSession(sessionId);
    const tokenHash = this.email.hash(token);
    const pending = this.pendingEmailLinks.get(tokenHash);
    if (!pending || pending.used || this.now() >= pending.expiresAtMs) throw new AuthError(COPY.emailLinkExpired);
    const existing = await this.deps.accounts.getEmailLogin(pending.emailHmac);
    if (existing && existing.accountId !== session.accountId) throw new AuthError(COPY.identityTaken);
    pending.used = true;
    if (!existing) await this.deps.accounts.putEmailLogin({ emailHmac: pending.emailHmac, accountId: session.accountId });
  }

  /** Attaches a freshly-registered passkey to the account the current session already belongs to. */
  async linkPasskeyToSession(sessionId: string, response: unknown, challenge: string): Promise<void> {
    const session = await this.currentSession(sessionId);
    await this.completeRegistration(response, challenge, session.accountId);
  }
}
