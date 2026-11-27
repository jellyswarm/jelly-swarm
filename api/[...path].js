import { forward } from "./_proxy.js";

// Vercel serverless function: same-origin /api/* proxy to the JellySwarm backend.
// MASTER_API_KEY and BACKEND_API_URL are server-side Vercel environment variables.
export default async function handler(req, res) {
  const result = await forward({ method: req.method, url: req.url, body: req.body });
  if (result.paymentRequired) res.setHeader("PAYMENT-REQUIRED", result.paymentRequired);
  res.setHeader("content-type", result.contentType);
  res.setHeader("cache-control", "no-store");
  return res.status(result.status).send(result.body);
}
