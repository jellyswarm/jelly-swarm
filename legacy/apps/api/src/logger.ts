import pino from "pino";

/**
 * Structured (JSON-lines) logging for container log aggregation. Deliberately no
 * pino-pretty/transport here — those spawn a worker thread, which is one more thing to get
 * wrong under Bun; plain JSON to stdout is also just what a log collector wants anyway.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "jelly-api" },
});
