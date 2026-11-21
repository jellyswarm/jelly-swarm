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

async function proxyToApi(req: Request, url: URL, clientIp: string | undefined): Promise<Response> {
  const target = API_URL + (url.pathname.slice(API_PREFIX.length) || "/") + url.search;
  const headers = new Headers(req.headers);
  for (const h of [...HOP_BY_HOP, "host", "origin", "referer", "accept-encoding"]) headers.delete(h);
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
