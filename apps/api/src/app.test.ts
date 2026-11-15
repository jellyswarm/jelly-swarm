import { describe, expect, test } from "bun:test";
import { signer } from "@jelly/checker/src/testkit";
import { COLUMNS, makeService } from "@jelly/service/src/testkit";
import { MemoryNonceStore, TRANSFER_WITH_AUTHORIZATION_TYPES, X402_VERSION, encodePaymentHeader } from "@jelly/x402";
import type { Address, Hex } from "viem";
import { createApp } from "./app";

const WALLET = "0x000000000000000000000000000000000000dEaD" as Address;
const DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address };

function makeTestApp(over: Parameters<typeof makeService>[0] = {}, withStats = false) {
  const s = makeService(over);
  let verifyOk = true;
  let settleOk = true;
  const app = createApp({
    service: s.service,
    escrow: s.escrow,
    bus: s.bus,
    store: s.store,
    nonces: new MemoryNonceStore(),
    publicUrl: "https://api.jellyswarm.test",
    facilitator: {
      verify: async () => (verifyOk ? { isValid: true, payer: WALLET } : { isValid: false, invalidReason: "invalid_signature" }),
      settle: async () => (settleOk ? { success: true, transaction: "0xpaid", payer: WALLET } : { success: false, errorReason: "settlement_failed" }),
    },
    ...(withStats ? { stats: { store: s.store, studioOperated: true, now: () => s.clock.now } } : {}),
  });
  return {
    ...s,
    app,
    setFacilitatorOk: (v: boolean, phase: "verify" | "settle" = "verify") => {
      if (phase === "verify") verifyOk = v;
      else settleOk = v;
    },
  };
}

const req = (app: ReturnType<typeof makeTestApp>["app"], path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json: body, headers, ...rest } = init;
  return app.request(path, {
    ...rest,
    headers: { ...(headers as Record<string, string>), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
};
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function quoteAndKey(t: ReturnType<typeof makeTestApp>, items = ["tok-0", "tok-1"]) {
  const res = await req(t.app, "/v1/quotes", { method: "POST", json: { task: "x", items, columns: COLUMNS } });
  const data = (await res.json()) as { accessKey: string; quoteId: string };
  return { status: res.status, accessKey: data.accessKey, quoteId: data.quoteId };
}

describe("REST: quotes and jobs", () => {
  test("an anonymous quote issues a one-time access key that then reads the job back", async () => {
    const t = makeTestApp();
    const { status, accessKey, quoteId } = await quoteAndKey(t);
    expect(status).toBe(201);
    expect(accessKey).toBeTruthy();

    const fund = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    expect(fund.status).toBe(200);
    const { job } = (await fund.json()) as { job: { jobKey: Hex; state: string } };
    expect(job.state).toBe("awaiting_payment");

    const noAuth = await req(t.app, `/v1/jobs/${job.jobKey}`);
    expect(noAuth.status).toBe(403);
    const withAuth = await req(t.app, `/v1/jobs/${job.jobKey}`, { headers: auth(accessKey) });
    expect(withAuth.status).toBe(200);
  });

  test("an unauthenticated write beyond quoting is refused", async () => {
    const t = makeTestApp();
    const res = await req(t.app, "/v1/jobs", { method: "POST", json: { quoteId: crypto.randomUUID(), route: "wallet", payer: WALLET } });
    expect(res.status).toBe(403);
    expect((await res.json() as { message: string }).message).toContain("Authorization: Bearer");
  });

  test("a bad body is 400, not a 500", async () => {
    const t = makeTestApp();
    const { accessKey } = await quoteAndKey(t);
    const res = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId: "not-a-uuid" } });
    expect(res.status).toBe(400);
  });

  test("a confirmed job runs end to end through the REST surface", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0", "bad-1"]);
    const fund = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    const { job } = (await fund.json()) as { job: { jobKey: Hex } };
    const jobId = (await t.store.getJob(job.jobKey))!.jobId;
    t.escrow.markFunded(jobId, WALLET);

    const confirmed = await req(t.app, `/v1/jobs/${job.jobKey}/confirm`, { method: "POST", headers: auth(accessKey) });
    expect(confirmed.status).toBe(200);
    await t.service.finished(job.jobKey);

    const status = await req(t.app, `/v1/jobs/${job.jobKey}`, { headers: auth(accessKey) });
    expect((await status.json() as { state: string }).state).toBe("settled");
    const result = await req(t.app, `/v1/jobs/${job.jobKey}/result?format=csv`, { headers: auth(accessKey) });
    expect((await result.json() as { content: string }).content).toContain("tok-0");

    const list = await req(t.app, "/v1/jobs", { headers: auth(accessKey) });
    expect((await list.json() as { jobs: unknown[] }).jobs).toHaveLength(1);

    const dispute = await req(t.app, `/v1/jobs/${job.jobKey}/disputes`, { method: "POST", headers: auth(accessKey), json: { rowIdx: [0], evidence: "" } });
    expect(dispute.status).toBe(201);
  });
});

describe("x402", () => {
  async function signedPayment(payTo: Address, amount: string) {
    const authorization = {
      from: WALLET,
      to: payTo,
      value: amount,
      validAfter: "0",
      validBefore: "2000000000",
      nonce: `0x${"22".repeat(32)}` as Hex,
    };
    const signature = await signer.signTypedData({
      domain: DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { ...authorization, value: BigInt(amount), validAfter: 0n, validBefore: 2_000_000_000n },
    });
    return { x402Version: X402_VERSION, scheme: "exact" as const, network: "eip155:8453", payload: { signature, authorization } };
  }

  test("without a payment header, a 402 lists exactly what to pay and where", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0"]);
    const res = await req(t.app, "/v1/x402/jobs", { method: "POST", headers: { ...auth(accessKey), "x-jelly-payer": WALLET }, json: { quoteId } });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: { payTo: Address; maxAmountRequired: string; asset: Address }[] };
    expect(body.accepts[0]!.maxAmountRequired).toBe("265000"); // $0.25 + 1 × $0.015
    expect(body.accepts[0]!.asset).toBe(t.escrow.asset.address);
  });

  test("a valid payment starts the job; a facilitator refusal does not", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0"]);
    const quoted402 = await req(t.app, "/v1/x402/jobs", { method: "POST", headers: { ...auth(accessKey), "x-jelly-payer": WALLET }, json: { quoteId } });
    const { accepts } = (await quoted402.json()) as { accepts: { payTo: Address; maxAmountRequired: string }[] };
    const payment = await signedPayment(accepts[0]!.payTo, accepts[0]!.maxAmountRequired);

    t.setFacilitatorOk(false);
    const refused = await req(t.app, "/v1/x402/jobs", {
      method: "POST",
      headers: { ...auth(accessKey), "x-jelly-payer": WALLET, "x-payment": encodePaymentHeader(payment) },
      json: { quoteId },
    });
    expect(refused.status).toBe(402);

    t.setFacilitatorOk(true);
    const ok = await req(t.app, "/v1/x402/jobs", {
      method: "POST",
      headers: { ...auth(accessKey), "x-jelly-payer": WALLET, "x-payment": encodePaymentHeader(payment) },
      json: { quoteId },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-payment-response")).toBeTruthy();
    const { job } = (await ok.json()) as { job: { state: string } };
    expect(job.state).toBe("running");
  });

  test("replaying the same payment authorization is refused", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId: q1 } = await quoteAndKey(t, ["tok-0"]);
    const { quoteId: q2 } = await quoteAndKey(t, ["tok-1"]);
    const first402 = await req(t.app, "/v1/x402/jobs", { method: "POST", headers: { ...auth(accessKey), "x-jelly-payer": WALLET }, json: { quoteId: q1 } });
    const { accepts } = (await first402.json()) as { accepts: { payTo: Address; maxAmountRequired: string }[] };
    const payment = await signedPayment(accepts[0]!.payTo, accepts[0]!.maxAmountRequired);
    const header = encodePaymentHeader(payment);

    const first = await req(t.app, "/v1/x402/jobs", { method: "POST", headers: { ...auth(accessKey), "x-jelly-payer": WALLET, "x-payment": header }, json: { quoteId: q1 } });
    expect(first.status).toBe(200);
    const replay = await req(t.app, "/v1/x402/jobs", { method: "POST", headers: { ...auth(accessKey), "x-jelly-payer": WALLET, "x-payment": header }, json: { quoteId: q2 } });
    expect(replay.status).toBe(402);
  });

  test("a top-up below $5 is refused before any payment is requested", async () => {
    const t = makeTestApp();
    const res = await req(t.app, "/v1/x402/keys", { method: "POST", json: { owner: WALLET, amountUsd: "4.99" } });
    expect(res.status).toBe(400);
  });

  test("the x402 and agent-card documents are published", async () => {
    const t = makeTestApp();
    const card = await req(t.app, "/.well-known/agent-card.json");
    expect((await card.json() as { skills: unknown[] }).skills).toHaveLength(2);
    const manifest = await req(t.app, "/.well-known/x402");
    expect((await manifest.json() as { resources: unknown[] }).resources.length).toBeGreaterThan(0);
  });
});

describe("/stats", () => {
  test("is not served unless the deployment opts in", async () => {
    const t = makeTestApp();
    expect((await req(t.app, "/stats")).status).toBe(404);
  });

  test("GET /stats and /stats.json report a finished job's classified volume", async () => {
    const t = makeTestApp({}, true);
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0", "tok-1"]);
    const fund = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    const { job } = (await fund.json()) as { job: { jobKey: Hex } };
    const stored = (await t.store.getJob(job.jobKey))!;
    t.escrow.markFunded(stored.jobId, WALLET);
    await req(t.app, `/v1/jobs/${job.jobKey}/confirm`, { method: "POST", headers: auth(accessKey) });
    await t.service.finished(job.jobKey);
    await t.store.updateJob(job.jobKey, { state: "finalized", meterBucket: "real" });

    for (const path of ["/stats", "/stats.json"]) {
      const res = await req(t.app, path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { volume: { product: string; totals: { real: string } }[]; disclosures: string[] };
      expect(body.volume[0]).toMatchObject({ product: "fanout", totals: { real: "0.28" } });
      expect(body.disclosures.length).toBeGreaterThan(0);
    }
  });

  test("the lookback window is bounded by ?days=", async () => {
    const t = makeTestApp({}, true);
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0"]);
    await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    const stored = (await t.store.getJobByQuote(quoteId))!;
    await t.store.updateJob(stored.jobKey, { state: "finalized", meterBucket: "real" });
    t.clock.now += 40 * 24 * 3600 * 1000; // the job is now older than the default 30-day window

    const wide = await req(t.app, "/stats?days=60");
    expect((await wide.json() as { volume: unknown[] }).volume).toHaveLength(1);
    const narrow = await req(t.app, "/stats?days=30");
    expect((await narrow.json() as { volume: unknown[] }).volume).toHaveLength(0);
  });
});

/** Reads an SSE Response for up to `ms`, then cancels the stream and returns what arrived. */
async function readSse(res: Response, ms = 50): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), remaining))]);
    if (result.done) break;
    text += decoder.decode(result.value);
  }
  await reader.cancel();
  return text;
}

describe("live progress: SSE (§11.2)", () => {
  test("GET /v1/jobs/:key/events replays persisted events, then streams new ones from the bus", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0"]);
    const fund = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    const { job } = (await fund.json()) as { job: { jobKey: Hex } };
    const stored = (await t.store.getJob(job.jobKey))!;
    t.escrow.markFunded(stored.jobId, WALLET);
    await req(t.app, `/v1/jobs/${job.jobKey}/confirm`, { method: "POST", headers: auth(accessKey) });
    await t.service.finished(job.jobKey);

    const res = await req(t.app, `/v1/jobs/${job.jobKey}/events`, { headers: auth(accessKey) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await readSse(res);
    expect(body).toContain("event: job.quoted");
    expect(body).toContain("event: job.funded");
    expect(body).toContain("event: job.settled");
    expect(body).toMatch(/^id: 1\n/m);
  });

  test("the owner channel, and only the owner, can open the stream", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0"]);
    const fund = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    const { job } = (await fund.json()) as { job: { jobKey: Hex } };

    const noAuth = await req(t.app, `/v1/jobs/${job.jobKey}/events`);
    expect(noAuth.status).toBe(403);
    const otherKey = (await t.service.issueAnonymousKey()).secret;
    const notOwner = await req(t.app, `/v1/jobs/${job.jobKey}/events`, { headers: auth(otherKey) });
    expect(notOwner.status).toBe(404);
  });

  test("Last-Event-ID resumes without repeating earlier events", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0"]);
    const fund = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    const { job } = (await fund.json()) as { job: { jobKey: Hex } };
    const stored = (await t.store.getJob(job.jobKey))!;
    t.escrow.markFunded(stored.jobId, WALLET);
    await req(t.app, `/v1/jobs/${job.jobKey}/confirm`, { method: "POST", headers: auth(accessKey) });
    await t.service.finished(job.jobKey);

    const first = await readSse(await req(t.app, `/v1/jobs/${job.jobKey}/events`, { headers: auth(accessKey) }));
    const firstId = Number(/^id: (\d+)/m.exec(first)![1]);

    const resumed = await readSse(
      await req(t.app, `/v1/jobs/${job.jobKey}/events`, { headers: { ...auth(accessKey), "last-event-id": String(firstId) } }),
    );
    expect(resumed).not.toContain("event: job.quoted"); // already delivered before the resume point
    expect(resumed).toContain("event: job.settled");
  });

  test("a finished job's event log includes the live tile grid and the ETA", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0", "tok-1"]);
    const fund = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    const { job } = (await fund.json()) as { job: { jobKey: Hex } };
    const stored = (await t.store.getJob(job.jobKey))!;
    t.escrow.markFunded(stored.jobId, WALLET);
    await req(t.app, `/v1/jobs/${job.jobKey}/confirm`, { method: "POST", headers: auth(accessKey) });
    await t.service.finished(job.jobKey);

    const body = await readSse(await req(t.app, `/v1/jobs/${job.jobKey}/events`, { headers: auth(accessKey) }));
    expect(body).toContain("event: tile");
    expect(body).toContain("event: eta");
    expect(body).toContain("event: cost");
  });

  test("a live subscriber sees a new event as soon as it is published, without re-polling", async () => {
    const t = makeTestApp();
    const { accessKey, quoteId } = await quoteAndKey(t, ["tok-0"]);
    const fund = await req(t.app, "/v1/jobs", { method: "POST", headers: auth(accessKey), json: { quoteId, route: "wallet", payer: WALLET } });
    const { job } = (await fund.json()) as { job: { jobKey: Hex } };

    const res = await req(t.app, `/v1/jobs/${job.jobKey}/events`, { headers: auth(accessKey) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const read = reader.read();
    t.bus.publish(job.jobKey, { seq: 99, ts: Date.now(), type: "eta", payload: { sec: 5 } });
    const { value } = await read;
    expect(decoder.decode(value)).toContain("event: eta");
    await reader.cancel();
  });
});

describe("tRPC", () => {
  test("quote and get work the same as REST, under the same auth rule", async () => {
    const t = makeTestApp();
    const anon = await t.service.issueAnonymousKey();
    const quoteRes = await req(t.app, "/trpc/jobs.quote", {
      method: "POST",
      headers: auth(anon.secret),
      json: { task: "x", items: ["tok-0"], columns: COLUMNS },
    });
    expect(quoteRes.status).toBe(200);

    const noAuth = await req(t.app, "/trpc/jobs.list?input=%7B%7D");
    expect(noAuth.status).toBe(401);
  });
});
