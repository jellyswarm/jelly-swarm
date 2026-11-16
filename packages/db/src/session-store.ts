import { randomBytes } from "node:crypto";
import type { Session, SessionStore } from "@jelly/auth";
import { eq } from "drizzle-orm";
import type { Db } from "./index";
import * as schema from "./schema";

/** Postgres-backed SessionStore (§10.1 `sessions` table). */
export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async create(accountId: string, deviceId: string | undefined, nowMs: number, ttlMs: number): Promise<Session> {
    const session: Session = {
      id: randomBytes(24).toString("base64url"),
      accountId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      expiresAtMs: nowMs + ttlMs,
    };
    await this.db.insert(schema.sessions).values({
      id: session.id,
      accountId,
      deviceId: deviceId ?? null,
      expiresAt: new Date(session.expiresAtMs),
    });
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    const [row] = await this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1);
    if (!row || row.accountId === null) return undefined;
    return {
      id: row.id,
      accountId: row.accountId,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      expiresAtMs: row.expiresAt.getTime(),
    };
  }

  async revoke(id: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  }
}
