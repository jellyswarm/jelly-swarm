import type { AccountRecord, AccountStore, DeviceRecord, EmailLoginRecord, PasskeyRecord, WalletRecord } from "@jelly/auth";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import * as schema from "./schema";

// credentialId and emailHmac are base64url throughout @jelly/auth (WebAuthn's own encoding
// for the former; PasskeyChallenges/EmailLinks' own choice for the latter), never hex.
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** Postgres-backed AccountStore (§10.1, day1.md #23). */
export class PgAccountStore implements AccountStore {
  constructor(private readonly db: Db) {}

  async createAccount(): Promise<AccountRecord> {
    const [row] = await this.db.insert(schema.accounts).values({}).returning();
    return { id: row!.id, createdAtMs: row!.createdAt.getTime() };
  }

  async getAccount(id: string): Promise<AccountRecord | undefined> {
    const [row] = await this.db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).limit(1);
    if (!row) return undefined;
    return {
      id: row.id,
      createdAtMs: row.createdAt.getTime(),
      ...(row.bannedAt ? { bannedAtMs: row.bannedAt.getTime() } : {}),
    };
  }

  async getPasskey(credentialId: string): Promise<PasskeyRecord | undefined> {
    const target = Buffer.from(credentialId, "base64url");
    const [row] = await this.db.select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, target)).limit(1);
    if (!row) return undefined;
    return {
      credentialId: b64u(row.credentialId),
      accountId: row.accountId,
      publicKey: row.publicKey,
      signCount: row.signCount,
      ...(row.transports ? { transports: row.transports } : {}),
    };
  }

  async putPasskey(p: PasskeyRecord): Promise<void> {
    await this.db
      .insert(schema.passkeys)
      .values({
        credentialId: Buffer.from(p.credentialId, "base64url"),
        accountId: p.accountId,
        publicKey: p.publicKey,
        signCount: p.signCount,
        transports: p.transports ?? null,
      })
      .onConflictDoNothing();
  }

  async setPasskeySignCount(credentialId: string, signCount: number): Promise<void> {
    await this.db.update(schema.passkeys).set({ signCount }).where(eq(schema.passkeys.credentialId, Buffer.from(credentialId, "base64url")));
  }

  async getEmailLogin(emailHmac: string): Promise<EmailLoginRecord | undefined> {
    const target = Buffer.from(emailHmac, "base64url");
    const [row] = await this.db.select().from(schema.emailLogins).where(eq(schema.emailLogins.emailHmac, target)).limit(1);
    return row ? { emailHmac: b64u(row.emailHmac), accountId: row.accountId } : undefined;
  }

  async putEmailLogin(e: EmailLoginRecord): Promise<void> {
    await this.db
      .insert(schema.emailLogins)
      .values({ emailHmac: Buffer.from(e.emailHmac, "base64url"), accountId: e.accountId })
      .onConflictDoNothing();
  }

  async getDevice(id: string): Promise<DeviceRecord | undefined> {
    const [row] = await this.db.select().from(schema.devices).where(eq(schema.devices.id, id)).limit(1);
    if (!row) return undefined;
    return { id: row.id, ...(row.accountId ? { accountId: row.accountId } : {}), powPenaltyBits: row.powPenaltyBits };
  }

  async putDevice(d: DeviceRecord): Promise<void> {
    await this.db
      .insert(schema.devices)
      .values({ id: d.id, accountId: d.accountId ?? null, powPenaltyBits: d.powPenaltyBits })
      .onConflictDoUpdate({
        target: schema.devices.id,
        set: { accountId: d.accountId ?? null, powPenaltyBits: d.powPenaltyBits },
      });
  }

  async getWallet(chain: string, address: string): Promise<WalletRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.wallets)
      .where(and(eq(schema.wallets.chain, chain), eq(schema.wallets.address, address.toLowerCase())))
      .limit(1);
    if (!row) return undefined;
    return { address: row.address, chain: row.chain, accountId: row.accountId, kind: row.kind as WalletRecord["kind"] };
  }

  async putWallet(w: WalletRecord): Promise<void> {
    await this.db
      .insert(schema.wallets)
      .values({ address: w.address.toLowerCase(), chain: w.chain, accountId: w.accountId, kind: w.kind })
      .onConflictDoNothing();
  }
}
