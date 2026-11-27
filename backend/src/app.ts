import express from "express";
import { timingSafeEqual } from "node:crypto";
import { healthRouter } from "./routes/health";

export const app = express();
app.disable("x-powered-by");
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

app.use((_req, res) => res.status(404).json({ error: "not_found" }));
