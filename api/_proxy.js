import { isIP } from "node:net";

// Server-side proxy rules shared by the Vercel function (api/proxy.js) and the local
// Vite dev server (vite.config.js). The browser only ever calls same-origin /api/...; this code
// adds the backend key on the server, so the key never reaches the page and no CORS is needed.

const JOB_ID = "(?:0x)?[0-9a-fA-F]{64}";
const JOB_PAYMENT = new RegExp(`^/jobs/${JOB_ID}/payment$`);
const JOB_READ = new RegExp(`^/jobs/${JOB_ID}(?:/agents)?$`);
const ADMIN_JOB = new RegExp(`^/admin/jobs/${JOB_ID}$`);
const ADMIN_SETTLEMENT_DATA = new RegExp(`^/admin/jobs/${JOB_ID}/settlement/typed-data$`);
const ADMIN_SETTLEMENT = new RegExp(`^/admin/jobs/${JOB_ID}/settlement$`);

function isAdminAllowed(method, path) {
  if (path === "/admin/session") return ["GET", "POST", "DELETE"].includes(method);
  if (["/admin/config", "/admin/summary", "/admin/jobs"].includes(path)) return method === "GET";
  if (method === "GET" && (ADMIN_JOB.test(path) || ADMIN_SETTLEMENT_DATA.test(path))) return true;
  if (method === "POST" && ADMIN_SETTLEMENT.test(path)) return true;
  return false;
}

function adminCookieHeader(rawCookie) {
  if (typeof rawCookie !== "string") return undefined;
  const cookies = rawCookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith("jellyswarm_admin="));
  return cookies.length === 1 ? cookies[0] : undefined;
}

/** Public app routes. Admin routes have a separate explicit allowlist below. */
export function isAllowed(method, path) {
  if (method === "POST" && path === "/jobs") return true;
  if (method === "POST" && JOB_PAYMENT.test(path)) return true;
  if (method === "GET" && JOB_READ.test(path)) return true;
  return false;
}

/** "/api/jobs/0x.." -> "/jobs/0x..", or null if the path cannot be decoded. */
export function backendPath(url) {
  try {
    return decodeURIComponent(new URL(url, "https://jellyswarm.invalid").pathname).replace(/^\/api(?=\/|$)/, "");
  } catch {
    return null;
  }
}

/**
 * Forwards one allowed request to the backend.
 * Returns { status, contentType, paymentRequired, body } for the caller to relay.
 */
export async function forward({ method, url, body, env = process.env, clientIp, cookie }) {
  const backendUrl = env.BACKEND_API_URL;
  // MASTER_API_KEY is the documented name; API_KEY is accepted too (that is what Vercel has it saved as).
  const apiKey = env.MASTER_API_KEY || env.API_KEY;
  if (!backendUrl || !apiKey) return json(503, { error: "backend_proxy_not_configured" });

  const path = backendPath(url);
  if (path === null) return json(400, { error: "invalid_path" });
  if (!isAllowed(method, path) && !isAdminAllowed(method, path)) return json(404, { error: "not_found" });

  const target = new URL(path, backendUrl);
  target.search = new URL(url, "https://jellyswarm.invalid").search;
  const headers = { "x-api-key": apiKey, accept: "application/json" };
  if (typeof clientIp === "string" && isIP(clientIp.trim())) {
    headers["x-jellyswarm-client-ip"] = clientIp.trim();
  }
  if (path.startsWith("/admin/")) {
    const sessionCookie = adminCookieHeader(cookie);
    if (sessionCookie) headers.cookie = sessionCookie;
  }
  let payload;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body ?? {});
  }

  try {
    const upstream = await fetch(target, { method, headers, body: payload });
    return {
      status: upstream.status,
      contentType: upstream.headers.get("content-type") ?? "application/json",
      paymentRequired: upstream.headers.get("payment-required"),
      setCookie: path.startsWith("/admin/") ? upstream.headers.get("set-cookie") : null,
      requestId: upstream.headers.get("x-request-id"),
      body: await upstream.text(),
    };
  } catch {
    return json(502, { error: "backend_unavailable" });
  }
}

function json(status, value) {
  return { status, contentType: "application/json", paymentRequired: null, setCookie: null, requestId: null, body: JSON.stringify(value) };
}
