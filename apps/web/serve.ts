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

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
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

console.log(`web listening on :${PORT}`);
