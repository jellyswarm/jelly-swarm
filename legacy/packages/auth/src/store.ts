/**
 * §10.1 "one accounts row and several identities". An account is just an id;
 * every sign-in method resolves to one, and `MemoryAccountStore` is the
 * stand-in used here until a Postgres-backed store exists (same pattern as
 * `MemoryJobStore` and `MemoryEscrow` in `@jelly/service`).
 */
export type AccountRecord = {
  id: string;
  createdAtMs: number;
  /** free | paid | holder. A ban blocks new jobs only; it is read elsewhere, never here. */
  bannedAtMs?: number;
};

export type PasskeyRecord = {
  credentialId: string;
  accountId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports?: string[];
};

/** Only `HMAC(pepper, lowercase(email))` is ever stored (§10.1). */
export type EmailLoginRecord = { emailHmac: string; accountId: string };

export type DeviceRecord = {
  id: string;
  accountId?: string;
  /** Extra PoW difficulty bits from abuse feedback (§10.3); read and written by `@jelly/abuse`. */
  powPenaltyBits: number;
};

export type WalletRecord = { address: string; chain: string; accountId: string; kind: "embedded" | "external" | "backup" };

export interface AccountStore {
  createAccount(): Promise<AccountRecord>;
  getAccount(id: string): Promise<AccountRecord | undefined>;

  getPasskey(credentialId: string): Promise<PasskeyRecord | undefined>;
  putPasskey(p: PasskeyRecord): Promise<void>;
  setPasskeySignCount(credentialId: string, signCount: number): Promise<void>;

  getEmailLogin(emailHmac: string): Promise<EmailLoginRecord | undefined>;
  putEmailLogin(e: EmailLoginRecord): Promise<void>;

  getDevice(id: string): Promise<DeviceRecord | undefined>;
  putDevice(d: DeviceRecord): Promise<void>;

  getWallet(chain: string, address: string): Promise<WalletRecord | undefined>;
  putWallet(w: WalletRecord): Promise<void>;
}

export class MemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly passkeys = new Map<string, PasskeyRecord>();
  private readonly emailLogins = new Map<string, EmailLoginRecord>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly wallets = new Map<string, WalletRecord>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async createAccount(): Promise<AccountRecord> {
    const record: AccountRecord = { id: `acct_${++this.seq}_${this.now()}`, createdAtMs: this.now() };
    this.accounts.set(record.id, record);
    return record;
  }

  async getAccount(id: string): Promise<AccountRecord | undefined> {
    return this.accounts.get(id);
  }

  async getPasskey(credentialId: string): Promise<PasskeyRecord | undefined> {
    return this.passkeys.get(credentialId);
  }

  async putPasskey(p: PasskeyRecord): Promise<void> {
    this.passkeys.set(p.credentialId, p);
  }

  async setPasskeySignCount(credentialId: string, signCount: number): Promise<void> {
    const p = this.passkeys.get(credentialId);
    if (p) p.signCount = signCount;
  }

  async getEmailLogin(emailHmac: string): Promise<EmailLoginRecord | undefined> {
    return this.emailLogins.get(emailHmac);
  }

  async putEmailLogin(e: EmailLoginRecord): Promise<void> {
    this.emailLogins.set(e.emailHmac, e);
  }

  async getDevice(id: string): Promise<DeviceRecord | undefined> {
    return this.devices.get(id);
  }

  async putDevice(d: DeviceRecord): Promise<void> {
    this.devices.set(d.id, d);
  }

  async getWallet(chain: string, address: string): Promise<WalletRecord | undefined> {
    return this.wallets.get(`${chain}:${address.toLowerCase()}`);
  }

  async putWallet(w: WalletRecord): Promise<void> {
    this.wallets.set(`${w.chain}:${w.address.toLowerCase()}`, w);
  }
}
