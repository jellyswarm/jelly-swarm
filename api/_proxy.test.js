import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { forward, isAllowed } from "./_proxy.js";

const JOB = "0x" + "ab".repeat(32);

describe("allowlist", () => {
  test("exposes only job creation, payment verification and job reads", () => {
    expect(isAllowed("POST", "/jobs")).toBe(true);
    expect(isAllowed("POST", `/jobs/${JOB}/payment`)).toBe(true);
    expect(isAllowed("GET", `/jobs/${JOB}`)).toBe(true);
    expect(isAllowed("GET", `/jobs/${JOB}/agents`)).toBe(true);
  });

  test("never exposes settlement, health or other methods", () => {
    expect(isAllowed("GET", `/jobs/${JOB}/settlement/typed-data`)).toBe(false);
    expect(isAllowed("POST", `/jobs/${JOB}/settlement`)).toBe(false);
    expect(isAllowed("GET", "/health")).toBe(false);
    expect(isAllowed("GET", "/jobs")).toBe(false);
    expect(isAllowed("DELETE", `/jobs/${JOB}`)).toBe(false);
    expect(isAllowed("GET", `/jobs/${JOB}/../settlement`)).toBe(false);
  });
});

describe("forward", () => {
  let server;
  let seen;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = { method: req.method, path: new URL(req.url).pathname, key: req.headers.get("x-api-key"), clientIp: req.headers.get("x-jellyswarm-client-ip"), body: await req.text() };
        return new Response(JSON.stringify({ error: "payment_required", jobId: JOB }), {
          status: 402,
          headers: { "content-type": "application/json", "payment-required": "eyJ4In0=" },
        });
      },
    });
  });
  afterAll(() => server.stop(true));

  const env = () => ({ BACKEND_API_URL: `http://localhost:${server.port}`, MASTER_API_KEY: "secret-key" });

  test("adds the service key on the server and relays status, body and PAYMENT-REQUIRED", async () => {
    const out = await forward({ method: "POST", url: "/api/jobs", body: { task: "hi there", agentCount: 1 }, env: env(), clientIp: "203.0.113.7" });
    expect(seen.key).toBe("secret-key");
    expect(seen.clientIp).toBe("203.0.113.7");
    expect(seen.path).toBe("/jobs");
    expect(JSON.parse(seen.body)).toEqual({ task: "hi there", agentCount: 1 });
    expect(out.status).toBe(402);
    expect(out.paymentRequired).toBe("eyJ4In0=");
    expect(JSON.parse(out.body).jobId).toBe(JOB);
  });

  test("does not forward malformed client IP values", async () => {
    await forward({ method: "GET", url: `/api/jobs/${JOB}`, env: env(), clientIp: "not-an-ip" });
    expect(seen.clientIp).toBeNull();
  });

  test("refuses routes outside the allowlist without calling the backend", async () => {
    seen = undefined;
    const out = await forward({ method: "POST", url: `/api/jobs/${JOB}/settlement`, body: {}, env: env() });
    expect(out.status).toBe(404);
    expect(seen).toBeUndefined();
  });

  test("accepts the key saved as API_KEY", async () => {
    await forward({ method: "GET", url: `/api/jobs/${JOB}`, env: { BACKEND_API_URL: env().BACKEND_API_URL, API_KEY: "alt-key" } });
    expect(seen.key).toBe("alt-key");
  });

  test("returns 503 when the key or backend URL is missing", async () => {
    const out = await forward({ method: "GET", url: `/api/jobs/${JOB}`, env: {} });
    expect(out.status).toBe(503);
  });

  test("returns 502 when the backend is unreachable", async () => {
    const out = await forward({ method: "GET", url: `/api/jobs/${JOB}`, env: { BACKEND_API_URL: "http://127.0.0.1:1", MASTER_API_KEY: "k" } });
    expect(out.status).toBe(502);
  });
});

describe("Vercel rewrite", () => {
  test("restores the original /api path and query from the rewrite", async () => {
    const { originalUrl } = await import("./proxy.js");
    const job = "0x" + "ab".repeat(32);
    expect(originalUrl(`/api/proxy?__path=jobs/${job}/payment`)).toBe(`/api/jobs/${job}/payment`);
    expect(originalUrl(`/api/proxy?__path=jobs&x=1`)).toBe("/api/jobs?x=1");
    expect(originalUrl(`/api/jobs/${job}`)).toBe(`/api/jobs/${job}`);
  });
});
