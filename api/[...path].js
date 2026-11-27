const JOB_ID = "(?:0x)?[0-9a-fA-F]{64}";

function isAllowed(method, path) {
  if (method === "POST" && path === "/jobs") return true;
  if (method === "POST" && new RegExp(`^/jobs/${JOB_ID}/payment$`).test(path)) return true;
  if (method === "GET" && new RegExp(`^/jobs/${JOB_ID}(?:/agents)?$`).test(path)) return true;
  return false;
}

export default async function handler(req, res) {
  const backendUrl = process.env.BACKEND_API_URL;
  const apiKey = process.env.MASTER_API_KEY;
  if (!backendUrl || !apiKey) return res.status(503).json({ error: "backend_proxy_not_configured" });

  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "https://jellyswarm.invalid").pathname)
      .replace(/^\/api(?=\/|$)/, "");
  } catch {
    return res.status(400).json({ error: "invalid_path" });
  }
  if (!isAllowed(req.method, path)) return res.status(404).json({ error: "not_found" });

  const target = new URL(path, backendUrl);
  target.search = new URL(req.url, "https://jellyswarm.invalid").search;
  const headers = { "x-api-key": apiKey, accept: req.headers.accept ?? "application/json" };
  let body;
  if (req.method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.body ?? {});
  }

  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    const paymentRequired = upstream.headers.get("payment-required");
    if (paymentRequired) res.setHeader("PAYMENT-REQUIRED", paymentRequired);
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    return res.send(await upstream.text());
  } catch {
    return res.status(502).json({ error: "backend_unavailable" });
  }
}
