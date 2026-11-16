import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { PgAccountStore } from "./account-store";
import { createDb } from "./index";
import { runMigrations } from "./migrate";

const url = loadInfraEnv().DATABASE_URL;

async function ping(): Promise<boolean> {
  const { client, close } = createDb(url, { max: 1 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

const reachable = await ping();
if (!reachable && process.env.REQUIRE_INFRA === "1") {
  throw new Error(`REQUIRE_INFRA=1 but Postgres is not reachable at ${url}`);
}

describe.skipIf(!reachable)("PgAccountStore against Postgres", () => {
  test("account, passkey, email login, device and wallet round-trip", async () => {
    await runMigrations(url);
    const { db, close } = createDb(url, { max: 2 });
    const store = new PgAccountStore(db);

    const account = await store.createAccount();
    expect(await store.getAccount(account.id)).toEqual(account);

    const credentialId = randomBytes(16).toString("base64url");
    const passkey = { credentialId, accountId: account.id, publicKey: randomBytes(32), signCount: 0, transports: ["usb", "internal"] };
    await store.putPasskey(passkey);
    expect(await store.getPasskey(credentialId)).toEqual(passkey);
    await store.setPasskeySignCount(credentialId, 5);
    expect((await store.getPasskey(credentialId))!.signCount).toBe(5);

    const emailHmac = randomBytes(32).toString("base64url");
    await store.putEmailLogin({ emailHmac, accountId: account.id });
    expect(await store.getEmailLogin(emailHmac)).toEqual({ emailHmac, accountId: account.id });

    const deviceId = `dev-${randomBytes(8).toString("hex")}`;
    await store.putDevice({ id: deviceId, accountId: account.id, powPenaltyBits: 0 });
    expect(await store.getDevice(deviceId)).toEqual({ id: deviceId, accountId: account.id, powPenaltyBits: 0 });
    await store.putDevice({ id: deviceId, accountId: account.id, powPenaltyBits: 3 });
    expect((await store.getDevice(deviceId))!.powPenaltyBits).toBe(3);

    const address = `0x${randomBytes(20).toString("hex")}`;
    await store.putWallet({ address, chain: "base", accountId: account.id, kind: "embedded" });
    expect(await store.getWallet("base", address.toUpperCase())).toEqual({
      address: address.toLowerCase(),
      chain: "base",
      accountId: account.id,
      kind: "embedded",
    });

    await close();
  }, 30_000);
});
