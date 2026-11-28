import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { healthRouter } from "./routes/health";
import { jobsRouter } from "./routes/jobs";
import { adminRouter } from "./routes/admin";
import { consumeRateLimit } from "./services/rate-limit";

export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => {
    console.info(JSON.stringify({
      event: "http_request",
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use("/health", healthRouter);

// Health is intentionally public for platform probes. Every other API request
// requires the server-side master key; never expose this key in browser code.
app.use((req, res, next) => {
  const configuredKey = process.env.MASTER_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: "api_key_not_configured" });
  }

  const providedKey = req.header("x-api-key") ?? "";
  const expected = Buffer.from(configuredKey);
  const provided = Buffer.from(providedKey);
  const valid = expected.length === provided.length && timingSafeEqual(expected, provided);

  if (!valid) return res.status(401).json({ error: "unauthorized" });
  next();
});

app.use(async (req, res, next) => {
  if (!req.path.startsWith("/jobs")) return next();

  let scope: string | undefined;
  let limit = 0;
  if (req.method === "POST" && req.path === "/jobs") {
    scope = "quote";
    limit = 10;
  } else if (req.method === "POST" && /^\/jobs\/(?:0x)?[0-9a-fA-F]{64}\/payment$/.test(req.path)) {
    scope = "payment";
    limit = 30;
  } else if (req.method === "GET" && /^\/jobs\/(?:0x)?[0-9a-fA-F]{64}(?:\/agents)?$/.test(req.path)) {
    scope = "read";
    limit = 240;
  }
  if (!scope) return next();

  const clientIdentity = req.header("x-jellyswarm-client-ip") ?? req.ip ?? "unknown";
  const allowed = await consumeRateLimit(scope, clientIdentity, limit);
  if (!allowed) {
    const retryAfter = 60 - Math.floor((Date.now() % 60_000) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "rate_limit_exceeded", retryAfterSeconds: retryAfter });
  }
  return next();
});

app.use("/jobs", jobsRouter);
app.use("/admin", adminRouter);
app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({
    event: "http_request_error",
    requestId: res.getHeader("x-request-id"),
    method: req.method,
    path: req.path,
    errorType: error instanceof Error ? error.name : "unknown_error",
  }));
  res.status(500).json({ error: "internal_error" });
});
