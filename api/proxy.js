import { forward } from "./_proxy.js";

// Vercel function behind every /api/* path. vercel.json rewrites /api/<path> to
// /api/proxy?__path=<path>, because on non-Next projects a [...path] file only matches one segment.
// MASTER_API_KEY and BACKEND_API_URL are server-side Vercel environment variables.
export function originalUrl(reqUrl) {
  const url = new URL(reqUrl, "https://jellyswarm.invalid");
  const path = url.searchParams.get("__path");
  if (path === null) return reqUrl;
  url.searchParams.delete("__path");
  return `/api/${path.replace(/^\/+/, "")}${url.search}`;
}

export default async function handler(req, res) {
  const rawClientIp = req.headers["x-forwarded-for"];
  const clientIp = typeof rawClientIp === "string" ? rawClientIp.split(",", 1)[0].trim() : undefined;
  const result = await forward({ method: req.method, url: originalUrl(req.url), body: req.body, clientIp });
  if (result.paymentRequired) res.setHeader("PAYMENT-REQUIRED", result.paymentRequired);
  res.setHeader("content-type", result.contentType);
  res.setHeader("cache-control", "no-store");
  return res.status(result.status).send(result.body);
}
