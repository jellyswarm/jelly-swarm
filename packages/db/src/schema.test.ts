import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema";

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
const columns = tables.flatMap((t) => {
  const cfg = getTableConfig(t);
  return cfg.columns.map((c) => ({ table: cfg.name, name: c.name, type: c.getSQLType() }));
});

describe("schema hard rules (§0.1)", () => {
  test("has the tables the build doc lists", () => {
    const names = tables.map((t) => getTableConfig(t).name).sort();
    for (const required of [
      "accounts", "passkeys", "email_logins", "devices", "wallets", "tg_links", "api_keys", "sessions",
      "quotes", "jobs", "rows", "receipts", "job_events", "disputes",
      "templates", "template_versions", "share_links", "referrals", "credit_ledger", "free_grants",
      "operators", "node_audits", "payout_epochs", "burns", "meter_posts",
      "studio_wallets", "volume_ledger", "x402_payments",
    ]) {
      expect(names).toContain(required);
    }
  });

  test("no email plaintext: the only email column is the HMAC", () => {
    const emailish = columns.filter((c) => /e_?mail/i.test(c.name));
    expect(emailish).toEqual([{ table: "email_logins", name: "email_hmac", type: "bytea" }]);
  });

  test("no identity-document, card or personal-detail columns", () => {
    const banned =
      /^(kyc|kyb)|(^|_)(phone|full_name|first_name|last_name|surname|dob|date_of_birth|birth|ssn|passport|national_id|id_number|id_document|card|cvv|iban|street|postcode|zip)(_|$)/i;
    expect(columns.filter((c) => banned.test(c.name))).toEqual([]);
  });

  test("no full IP address column: only prefixes are stored", () => {
    const ipish = columns.filter((c) => /(^|_)ip(_|$)/i.test(c.name)).map((c) => c.name);
    expect(ipish).toEqual(["ip_prefix"]);
  });

  test("every money column is integer micro-dollars, never a float", () => {
    const money = columns.filter((c) => /_usd6$|_micros$/.test(c.name));
    expect(money.length).toBeGreaterThan(10);
    for (const c of money) expect(c.type).toBe("bigint");
    const floats = columns.filter((c) => /^(real|double precision|numeric|float)/i.test(c.type));
    expect(floats).toEqual([]);
  });

  test("the 247 cap is enforced in the database", () => {
    const checks = getTableConfig(schema.quotes).checks.map((c) => c.name);
    expect(checks).toContain("quotes_max_agents_cap");
  });
});
