/**
 * Static file server for this plain site (no build step, no router): serves
 * `dashboard.html` at `/dashboard`, `pages/agents.html` at `/pages/agents`,
 * etc., and 301s a direct `*.html` hit to its clean URL so the address bar
 * never shows the extension. Replaces `python3 -m http.server`.
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 4173);
const ROOT = import.meta.dir;

function safeJoin(root: string, pathname: string): string | null {
  const resolved = normalize(join(root, pathname.replace(/^\/+/, "")));
  return resolved.startsWith(normalize(root)) ? resolved : null;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * Same-origin API proxy: the browser calls `/api/*` on this server, and this server makes the
 * call to the JellySwarm API (apps/api) itself. The API sends no CORS headers, so this
 * server-side hop is what keeps the browser from blocking the dashboard's requests.
 * Set API_URL to the API's address (local default: http://localhost:3000).
 */
const API_URL = (process.env.API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const API_PREFIX = "/api";
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"];

/**
 * The caller's API credential (anonymous access key or sign-in session id) lives only in this
 * httpOnly cookie. Browser code never sees or sends it: this server lifts it out of the API's
 * responses, stores it here, and attaches it as `Authorization: Bearer` on its own call.
 */
const CRED_COOKIE = "jelly_cred";
const CRED_MAX_AGE = 365 * 24 * 3600;
/** Response fields that carry a credential for this browser. `/v1/x402/keys` returns a product key the user must copy, so it is left alone. */
const CRED_FIELDS = ["accessKey", "sessionId"] as const;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function credCookie(url: URL, value: string | null): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return value === null
    ? `${CRED_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
    : `${CRED_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CRED_MAX_AGE}${secure}`;
}

/** Cookie-authenticated, so a state-changing call must come from this site's own pages. */
function isCrossSite(req: Request, url: URL): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (req.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (req.headers.get("x-forwarded-host") ?? url.host);
  } catch {
    return true;
  }
}

/**
 * Local session routes, answered here and never forwarded:
 * - `POST /api/session` `{ key }` moves a credential an older build kept in localStorage into the cookie.
 * - `DELETE /api/session` signs this browser out.
 * - `GET /api/session` says whether a credential is held, without revealing it.
 */
async function sessionRoute(req: Request, url: URL): Promise<Response> {
  if (req.method === "GET") return Response.json({ active: Boolean(readCookie(req, CRED_COOKIE)) });
  if (req.method === "DELETE") return Response.json({ active: false }, { headers: { "set-cookie": credCookie(url, null) } });
  if (req.method === "POST") {
    let key: unknown;
    try { ({ key } = (await req.json()) as { key?: unknown }); } catch { /* fall through */ }
    if (typeof key !== "string" || !/^[\w.~+/=-]{8,512}$/.test(key)) {
      return Response.json({ error: "invalid", message: "Expected { key }." }, { status: 400 });
    }
    return Response.json({ active: true }, { headers: { "set-cookie": credCookie(url, key) } });
  }
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}

async function proxyToApi(req: Request, url: URL, clientIp: string | undefined): Promise<Response> {
  if (isCrossSite(req, url)) return Response.json({ error: "forbidden", message: "Cross-site request refused." }, { status: 403 });
  if (url.pathname === `${API_PREFIX}/session`) return sessionRoute(req, url);

  // The SSE stream used to carry the key in the URL; the cookie replaces it, so never forward one.
  const search = new URLSearchParams(url.search);
  search.delete("key");
  const qs = search.toString();
  const target = API_URL + (url.pathname.slice(API_PREFIX.length) || "/") + (qs ? `?${qs}` : "");
  const headers = new Headers(req.headers);
  for (const h of [...HOP_BY_HOP, "host", "origin", "referer", "accept-encoding", "authorization", "cookie"]) headers.delete(h);
  const cred = readCookie(req, CRED_COOKIE);
  if (cred) headers.set("authorization", `Bearer ${cred}`);
  // Forward only the API's own cookies (the device cookie), never this server's credential.
  const apiCookies = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${CRED_COOKIE}=`));
  if (apiCookies.length) headers.set("cookie", apiCookies.join("; "));
  if (clientIp) {
    // Keep the caller's real address for the API's rate limits and abuse checks.
    const prior = req.headers.get("x-forwarded-for");
    headers.set("x-forwarded-for", prior ? `${prior}, ${clientIp}` : clientIp);
  }
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  if (process.env.MASTER_API_KEY) headers.set("x-master-api-key", process.env.MASTER_API_KEY);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
      // @ts-expect-error Bun streams request bodies with duplex "half".
      duplex: "half",
    });
  } catch {
    return Response.json(
      { error: "unreachable", message: "Could not reach the JellySwarm service. Is it running?" },
      { status: 502 },
    );
  }
  const out = new Headers(upstream.headers);
  for (const h of [...HOP_BY_HOP, "content-encoding", "content-length"]) out.delete(h);
  if (upstream.ok && (out.get("content-type") ?? "").includes("application/json")) {
    const text = await upstream.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = undefined; }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const body = data as Record<string, unknown>;
      const issued = CRED_FIELDS.map((f) => body[f]).find((v): v is string => typeof v === "string" && v.length > 0);
      if (issued) {
        for (const f of CRED_FIELDS) delete body[f];
        delete body.accessKeyNote;
        out.append("set-cookie", credCookie(url, issued));
        return new Response(JSON.stringify(body), { status: upstream.status, statusText: upstream.statusText, headers: out });
      }
    }
    return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

Bun.serve({
  port: PORT,
  idleTimeout: 0, // live job progress is a long-lived SSE stream through the proxy
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX + "/")) {
      return proxyToApi(req, url, server.requestIP(req)?.address);
    }
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.endsWith(".html")) {
      let clean = pathname.slice(0, -".html".length);
      if (clean.endsWith("/index")) clean = clean.slice(0, -"index".length);
      if (!clean.startsWith("/")) clean = "/" + clean;
      return Response.redirect(clean + url.search, 301);
    }

    const candidates =
      pathname === "/" ? ["/index.html"] : pathname.endsWith("/") ? [pathname + "index.html"] : [pathname, pathname + ".html"];

    for (const candidate of candidates) {
      const filePath = safeJoin(ROOT, candidate);
      if (filePath && isFile(filePath)) {
        const headers = filePath.endsWith(".html") ? { "cache-control": "no-cache" } : {};
        return new Response(Bun.file(filePath), { headers });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`web listening on :${PORT} (API proxied from /api to ${API_URL})`);
