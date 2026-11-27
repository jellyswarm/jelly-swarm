import { randomBytes } from "node:crypto";

/**
 * Opaque server-held sessions (§10.1's `sessions` table). The id itself is
 * the only thing a client holds; everything else lives server-side, so a
 * session can be revoked by simply deleting it.
 */
export type Session = { id: string; accountId: string; deviceId?: string; expiresAtMs: number };

export interface SessionStore {
  create(accountId: string, deviceId: string | undefined, nowMs: number, ttlMs: number): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  revoke(id: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async create(accountId: string, deviceId: string | undefined, nowMs: number, ttlMs: number): Promise<Session> {
    const session: Session = {
      id: randomBytes(24).toString("base64url"),
      accountId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      expiresAtMs: nowMs + ttlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async revoke(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/** Live only if it still exists and has not expired; an expired session is treated as absent. */
export function isLive(session: Session | undefined, nowMs: number): session is Session {
  return session !== undefined && nowMs < session.expiresAtMs;
}
