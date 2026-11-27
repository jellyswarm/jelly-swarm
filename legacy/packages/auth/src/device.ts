import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * §10.1 (1) Anonymous device identity: "just open the page." The server
 * issues a signed cookie; the browser never has to prove anything beyond
 * holding it. Signed, not just random, so a device id can't be forged into
 * one that was never actually issued (which would let an attacker plant a
 * device with no PoW history, or impersonate a banned device's id to probe
 * its state).
 */
export type DeviceToken = { deviceId: string; expiresAtMs: number };

export class DeviceAuth {
  constructor(private readonly secret: string) {
    if (secret.length < 16) throw new Error("device secret is too short");
  }

  private sign(deviceId: string, expiresAtMs: number): string {
    return createHmac("sha256", this.secret).update(`${deviceId}.${expiresAtMs}`).digest("base64url");
  }

  /** A fresh device id and its signed cookie value, valid for `ttlMs` (default 1 year, §10.1). */
  issue(nowMs: number, ttlMs = 365 * 24 * 3600 * 1000): { deviceId: string; cookie: string } {
    const deviceId = randomBytes(16).toString("base64url");
    const expiresAtMs = nowMs + ttlMs;
    return { deviceId, cookie: `${deviceId}.${expiresAtMs}.${this.sign(deviceId, expiresAtMs)}` };
  }

  /** Verifies a cookie value, returning the device id if it is genuine and not expired. */
  verify(cookie: string, nowMs: number): DeviceToken | null {
    const parts = cookie.split(".");
    if (parts.length !== 3) return null;
    const [deviceId, expStr, sig] = parts as [string, string, string];
    const expiresAtMs = Number(expStr);
    if (!Number.isFinite(expiresAtMs)) return null;
    const expected = this.sign(deviceId, expiresAtMs);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (nowMs >= expiresAtMs) return null;
    return { deviceId, expiresAtMs };
  }
}
