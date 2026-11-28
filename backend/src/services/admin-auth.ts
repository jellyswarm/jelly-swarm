import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const ADMIN_SESSION_COOKIE = "jellyswarm_admin";
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

function configuredPassword(): string | undefined {
  const password = process.env.MASTER_ADMIN_PASSWORD;
  return password && password.length >= 16 ? password : undefined;
}

function signature(payload: string, password: string): string {
  return createHmac("sha256", password).update(`jellyswarm-admin-session-v1:${payload}`).digest("base64url");
}

function readCookie(req: Request): string | undefined {
  const matching = (req.header("cookie") ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (matching.length !== 1) return undefined;
  return matching[0].slice(ADMIN_SESSION_COOKIE.length + 1);
}

export function verifyAdminSession(req: Request): number | undefined {
  const password = configuredPassword();
  const token = readCookie(req);
  if (!password || !token) return undefined;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const payload = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(signature(payload, password), "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown; nonce?: unknown };
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(data.exp) || (data.exp as number) <= now || (data.exp as number) > now + ADMIN_SESSION_SECONDS) {
      return undefined;
    }
    if (typeof data.nonce !== "string" || data.nonce.length < 16) return undefined;
    return data.exp as number;
  } catch {
    return undefined;
  }
}

export function setAdminSessionCookie(res: Response): number {
  const password = configuredPassword();
  if (!password) throw new Error("admin_auth_not_configured");
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS;
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt, nonce: randomBytes(18).toString("base64url") })).toString("base64url");
  const token = `${payload}.${signature(payload, password)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${ADMIN_SESSION_COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_SECONDS}${secure}`);
  return expiresAt;
}

export function clearAdminSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${ADMIN_SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

export function adminPasswordMatches(candidate: unknown): boolean {
  const password = configuredPassword();
  if (!password || typeof candidate !== "string" || candidate.length > 1024) return false;
  const expected = createHash("sha256").update(password).digest();
  const supplied = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expected, supplied);
}

export function adminPasswordConfigured(): boolean {
  return configuredPassword() !== undefined;
}

export function requireAdminSession(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Cookie");
  if (!adminPasswordConfigured()) {
    res.status(503).json({ error: "admin_auth_not_configured" });
    return;
  }
  const expiresAt = verifyAdminSession(req);
  if (!expiresAt) {
    res.status(401).json({ error: "admin_unauthorized" });
    return;
  }
  res.locals.adminSessionExpiresAt = expiresAt;
  next();
}
