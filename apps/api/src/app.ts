import { trpcServer } from "@hono/trpc-server";
import { AuthError, type AuthService } from "@jelly/auth";
import type { WatchStore } from "@jelly/db";
import type { EventBus } from "@jelly/live";
import { type Account, type Escrow, type JobService, type JobStore, QuoteInput, ServiceError, type SignedGrant } from "@jelly/service";
import { type BurnRecord, buildStats } from "@jelly/settlement";
import { usd6 } from "@jelly/shared";
import { createBunWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import {
  type Facilitator,
  type NonceStore,
  type PaymentPayload,
  type PaymentRequirements,
  X402Error,
  decodePaymentHeader,
  encodePaymentResponse,
  paymentRequiredBody,
} from "@jelly/x402";
import { type Context, Hono } from "hono";
import { type Address, type Hex, isAddress, isHex } from "viem";
import { z } from "zod";
import { COPY } from "./copy";
import { appRouter } from "./trpc";

export type AppDeps = {
  service: JobService;
  escrow: Escrow;
  /** §11.2 live progress: fans out the same events `/v1/jobs/:key` replays from `eventsSince`. */
  bus: EventBus;
  store: JobStore;
  facilitator: Facilitator;
  nonces: NonceStore;
  /** Public base URL, used in payment requirements and the agent card. */
  publicUrl: string;
  onError?: (e: unknown) => void;
  /** Powers GET /stats and /stats.json (§"A public meter for real paid volume"). Omit to serve neither. */
  stats?: {
    store: JobStore;
    /** True while every worker and checker operator is studio-run; adds the disclosure lines. */
    studioOperated: boolean;
    burns?: () => Promise<readonly BurnRecord[]> | readonly BurnRecord[];
    now?: () => number;
  };
  /** Origins allowed to call this API from a browser (e.g. the dashboard's own origin). Omit to allow none. */
  corsOrigins?: readonly string[];
  /**
   * Exposes a same-shape stand-in for a real wallet signature: it marks a
   * job funded directly, without any payment. Only meaningful (and only
   * ever set) while `escrow` is `MemoryEscrow` — there is no real money for
   * it to move. Never set this against a real chain.
   */
  devFunding?: boolean;
  /**
   * Powers /v1/watches (Picket, §11.3/§12.1). Storage only: saves and lists
   * a watch request, same as the schema's own `watches` table comment —
   * there is no watch engine yet, so nothing is ever actually monitored.
   * Omit to serve none of these routes.
   */
  watches?: WatchStore;
  /** Powers /v1/auth/* (passkey, email link, external wallet). Omit to serve none of these routes. */
  auth?: AuthService;
};

type Env = { Variables: { account: Account } };

const STATUS: Record<ServiceError["code"], 400 | 402 | 403 | 404 | 409 | 410> = {
  not_found: 404,
  invalid: 400,
  expired: 410,
  not_ready: 409,
  payment_required: 402,
  forbidden: 403,
};

const JobKey = z.string().refine((s): s is Hex => isHex(s) && s.length === 66);
const Big = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const Grant = z.object({
  owner: z.string().refine((s): s is Address => isAddress(s)),
  keyId: z.string().refine((s): s is Hex => isHex(s) && s.length === 66),
  perJobCapUsd6: Big,
  perDayCapUsd6: Big,
  expiresAt: Big,
  periodCapUsd6: Big,
  minCoverageBps: z.number().int().min(0).max(10_000),
  signature: z.string().refine((s): s is Hex => isHex(s)),
}) satisfies z.ZodType<SignedGrant, unknown>;

const RunBody = z.discriminatedUnion("route", [
  z.object({ quoteId: z.string().uuid(), route: z.literal("wallet"), payer: z.string() }),
  z.object({ quoteId: z.string().uuid(), route: z.literal("vault"), grant: Grant.optional() }),
]);
const DisputeBody = z.object({ rowIdx: z.array(z.number().int().nonnegative()).min(1).max(25), evidence: z.string().max(4000).default("") });

/**
 * A Bearer token is either an access key (the existing per-key account space) or, when `auth`
 * is wired in, a live sign-in session id — tried in that order. A signed-in session resolves to
 * the real `accounts.id` row directly: `Account.id` is just an opaque string key to `JobService`,
 * so a session gives that identity's jobs/credits/referrals continuity across devices and keys.
 */
export async function accountFromRequest(service: JobService, authorization: string | undefined, auth?: AuthService): Promise<Account | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m) return null;
  const token = m[1]!;
  const viaKey = await service.accountForKey(token);
  if (viaKey) return viaKey;
  if (auth) {
    try {
      const session = await auth.currentSession(token);
      return { id: session.accountId, tier: "paid" };
    } catch {
      /* not a live session either */
    }
  }
  return null;
}

/** §9.2 REST /v1, x402, tRPC and the well-known documents. */
const { upgradeWebSocket, websocket } = createBunWebSocket();
/** Pass to `Bun.serve({ fetch: app.fetch, websocket })` wherever this app is actually hosted. */
export { websocket };

export function createApp(deps: AppDeps) {
  const { service, escrow } = deps;
  const app = new Hono<Env>();

  if (deps.corsOrigins?.length) {
    app.use("*", cors({ origin: [...deps.corsOrigins], allowHeaders: ["content-type", "authorization", "x-payment", "x-jelly-payer"], exposeHeaders: ["x-payment-response"] }));
  }

  app.onError((e, c) => {
    if (e instanceof ServiceError) return c.json({ error: e.code, message: e.message }, STATUS[e.code]);
    if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json({ error: "invalid", message: COPY.badRequest }, 400);
    // Internal faults are logged, never echoed: they can contain job content or host details.
    deps.onError?.(e);
    return c.json({ error: "internal", message: COPY.internal }, 500);
  });

  const requireAccount = async (c: Context<Env>): Promise<Account> => {
    const account = await accountFromRequest(service, c.req.header("authorization"), deps.auth);
    if (!account) throw new ServiceError("forbidden", COPY.unauthorized);
    return account;
  };
  const body = async <T>(c: Context<Env>, schema: z.ZodType<T>): Promise<T> => schema.parse(await c.req.json());
  const key = (c: Context<Env>): Hex => JobKey.parse(c.req.param("key"));

  // ───────────────────────── quotes and jobs ─────────────────────────

  /** Without a key, the caller is given one so they can read back what they create. */
  app.post("/v1/quotes", async (c) => {
    let account = await accountFromRequest(service, c.req.header("authorization"), deps.auth);
    let accessKey: string | undefined;
    if (!account) {
      accessKey = (await service.issueAnonymousKey()).secret;
      account = (await service.accountForKey(accessKey))!;
    }
    const quote = await service.quote(account, await body(c, QuoteInput));
    return c.json({ ...quote, ...(accessKey ? { accessKey, accessKeyNote: COPY.accessKeyNote } : {}) }, 201);
  });

  app.post("/v1/jobs", async (c) => {
    const account = await requireAccount(c);
    const b = await body(c, RunBody);
    if (b.route === "vault") return c.json({ job: await service.runFromVault(account, b.quoteId, b.grant) });
    return c.json(await service.prepare(account, b.quoteId, "wallet", b.payer));
  });

  app.post("/v1/jobs/:key/confirm", async (c) => c.json({ job: await service.confirm(await requireAccount(c), key(c)) }));

  app.get("/v1/jobs", async (c) => c.json({ jobs: await service.list(await requireAccount(c)) }));

  app.get("/v1/jobs/:key", async (c) => {
    const since = Number(c.req.query("sinceSeq") ?? "0");
    return c.json(await service.status(await requireAccount(c), key(c), Number.isInteger(since) && since > 0 ? since : 0));
  });

  /**
   * §11.2 SSE, owner channel, with Last-Event-ID resume. A client that
   * reconnects sends `Last-Event-ID` (or `?sinceSeq=`); it replays from the
   * durable log first, then streams whatever the bus publishes afterwards,
   * so no event in between is missed or duplicated.
   */
  app.get("/v1/jobs/:key/events", async (c) => {
    // The browser's EventSource cannot set a custom header, so (like /v1/ws below) this also
    // accepts the access key as a query parameter.
    const authHeader = c.req.header("authorization") ?? (c.req.query("key") ? `Bearer ${c.req.query("key")}` : undefined);
    const account = await accountFromRequest(service, authHeader, deps.auth);
    if (!account) throw new ServiceError("forbidden", COPY.unauthorized);
    const jobKey = key(c);
    await service.status(account, jobKey); // ownership check; throws not_found otherwise
    const sinceSeq = Number(c.req.header("last-event-id") ?? c.req.query("sinceSeq") ?? "0") || 0;

    let unsubscribe: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (e: { seq: number; type: string; payload: unknown }) => {
          controller.enqueue(new TextEncoder().encode(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`));
        };
        for (const e of await deps.store.eventsSince(jobKey, sinceSeq, 10_000)) send(e);
        unsubscribe = deps.bus.subscribe(jobKey, send);
      },
      cancel: () => unsubscribe?.(),
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  });

  app.get("/v1/jobs/:key/result", async (c) => {
    const format = z.enum(["json", "csv", "md"]).parse(c.req.query("format") ?? "json");
    return c.json(await service.result(await requireAccount(c), key(c), format));
  });

  app.get("/v1/jobs/:key/transcript", async (c) => {
    const row = c.req.query("row");
    const rowIdx = row === undefined ? undefined : z.coerce.number().int().nonnegative().parse(row);
    return c.json((await service.transcript(await requireAccount(c), key(c), rowIdx)) as object);
  });

  app.post("/v1/jobs/:key/disputes", async (c) => {
    const account = await requireAccount(c);
    const b = await body(c, DisputeBody);
    return c.json((await service.dispute(account, key(c), b.rowIdx, b.evidence)) as object, 201);
  });

  // ───────────────────────── shares (§11.4) ─────────────────────────

  app.post("/v1/jobs/:key/shares", async (c) => {
    const account = await requireAccount(c);
    const b = await body(c, z.object({ visibility: z.enum(["private", "unlisted", "public"]) }));
    return c.json(await service.createShare(account, key(c), b.visibility), 201);
  });

  app.get("/v1/shares/:slug", async (c) => {
    const account = await accountFromRequest(service, c.req.header("authorization"), deps.auth);
    return c.json(await service.getShare(c.req.param("slug"), account ?? undefined));
  });

  app.post("/v1/shares/:slug/visibility", async (c) => {
    const account = await requireAccount(c);
    const b = await body(c, z.object({ visibility: z.enum(["private", "unlisted", "public"]) }));
    await service.setShareVisibility(account, c.req.param("slug"), b.visibility);
    return c.json({ ok: true });
  });

  app.post("/v1/shares/:slug/rerun", async (c) => c.json(await service.rerunShare(await requireAccount(c), c.req.param("slug"))));

  // ───────────────────────── referrals and credits (§11.4, §10.3) ─────────────────────────

  app.get("/v1/account/referral-code", async (c) => c.json({ code: await service.referralCode(await requireAccount(c)) }));

  /** Without a key, the caller is given one, same as /v1/quotes: a real first-time visitor following a referral link has no account yet either. */
  app.post("/v1/account/referrals", async (c) => {
    let account = await accountFromRequest(service, c.req.header("authorization"), deps.auth);
    let accessKey: string | undefined;
    if (!account) {
      accessKey = (await service.issueAnonymousKey()).secret;
      account = (await service.accountForKey(accessKey))!;
    }
    const b = await body(c, z.object({ refCode: z.string().min(1).max(20) }));
    // No device/IP/funding-graph context exists on this request yet (day1.md #22): every
    // signal but the caller's own claim defaults to "no match", so self-referral detection
    // here is weaker than a real deployment's. See computeReferralSignals in @jelly/settlement
    // for the real signals this would use once a device cookie and wallet are wired in.
    const result = await service.registerReferral(account, b.refCode, { sameDevice: false, sameIpPrefix: false, fundingLinked: false });
    return c.json({ ...result, ...(accessKey ? { accessKey, accessKeyNote: COPY.accessKeyNote } : {}) });
  });

  app.get("/v1/account/credits", async (c) => c.json({ balanceUsd: await service.creditBalance(await requireAccount(c)) }));

  /**
   * Dev-only stand-in for a real wallet signature (see `devFunding` above):
   * marks a prepared job funded directly. Only registered when `devFunding`
   * is set, which only ever happens over `MemoryEscrow`.
   */
  if (deps.devFunding) {
    app.post("/v1/jobs/:key/dev-fund", async (c) => {
      const account = await requireAccount(c);
      const jobKey = key(c);
      await service.status(account, jobKey); // ownership check; throws not_found otherwise
      const job = await deps.store.getJob(jobKey);
      if (!job?.payer) throw new ServiceError("invalid", COPY.noPayer);
      (escrow as unknown as { markFunded: (jobId: bigint, client: Address) => void }).markFunded(job.jobId, job.payer as Address);
      return c.json({ ok: true });
    });
  }

  // ───────────────────────── watches (Picket, storage only) ─────────────────────────

  if (deps.watches) {
    const watches = deps.watches;
    /** Without a key, the caller is given one, same as /v1/quotes: this may be someone's first request. */
    app.post("/v1/watches", async (c) => {
      let account = await accountFromRequest(service, c.req.header("authorization"), deps.auth);
      let accessKey: string | undefined;
      if (!account) {
        accessKey = (await service.issueAnonymousKey()).secret;
        account = (await service.accountForKey(accessKey))!;
      }
      const b = await body(c, z.object({ target: z.string().min(1).max(200), condition: z.string().min(1).max(300) }));
      const watch = await watches.putWatch(account.id, b.target, b.condition);
      return c.json({ watch, ...(accessKey ? { accessKey, accessKeyNote: COPY.accessKeyNote } : {}) }, 201);
    });

    app.get("/v1/watches", async (c) => c.json({ watches: await watches.listWatches((await requireAccount(c)).id) }));

    app.delete("/v1/watches/:id", async (c) => {
      const account = await requireAccount(c);
      const deleted = await watches.deleteWatch(account.id, c.req.param("id"));
      if (!deleted) throw new ServiceError("not_found", COPY.watchNotFound);
      return c.json({ ok: true });
    });
  }

  // ───────────────────────── sign-in (§10.1) ─────────────────────────

  if (deps.auth) {
    const auth = deps.auth;
    const authErr = (e: unknown): never => {
      if (e instanceof AuthError) throw new ServiceError("invalid", e.message);
      throw e;
    };

    app.post("/v1/auth/passkey/register/begin", (c) => c.json(auth.beginPasskeyRegistration()));
    app.post("/v1/auth/passkey/register/complete", async (c) => {
      const b = await body(c, z.object({ challenge: z.string().min(1), response: z.unknown() }));
      try {
        const { accountId, session } = await auth.completeRegistration(b.response, b.challenge);
        return c.json({ accountId, sessionId: session.id }, 201);
      } catch (e) {
        authErr(e);
      }
    });

    app.post("/v1/auth/passkey/login/begin", (c) => c.json(auth.beginPasskeyAuthentication()));
    app.post("/v1/auth/passkey/login/complete", async (c) => {
      const b = await body(c, z.object({ challenge: z.string().min(1), credentialId: z.string().min(1), response: z.unknown() }));
      try {
        const { accountId, session, possibleClone } = await auth.completeAuthentication(b.credentialId, b.response, b.challenge);
        return c.json({ accountId, sessionId: session.id, possibleClone });
      } catch (e) {
        authErr(e);
      }
    });

    /** A plain sign-this-message challenge (§10.1 (4)), not full SIWE/EIP-4361. */
    app.post("/v1/auth/siwe/challenge", async (c) => {
      const b = await body(c, z.object({ address: z.string().refine((s): s is Address => isAddress(s)), chain: z.string().min(1).default("eip155:8453") }));
      return c.json(auth.issueSiweChallenge(b.address, b.chain));
    });
    app.post("/v1/auth/siwe/verify", async (c) => {
      const b = await body(
        c,
        z.object({
          address: z.string().refine((s): s is Address => isAddress(s)),
          message: z.string().min(1),
          signature: z.string().refine((s): s is Hex => isHex(s)),
          nonce: z.string().min(1),
        }),
      );
      try {
        const { accountId, session } = await auth.verifySiwe(b.address, b.message, b.signature, b.nonce);
        return c.json({ accountId, sessionId: session.id });
      } catch (e) {
        authErr(e);
      }
    });

    /** Dev-only: no mailer is wired in, so the link token is returned directly instead of emailed (mirrors POST /v1/jobs/:key/dev-fund). */
    app.post("/v1/auth/email/request", async (c) => {
      const b = await body(c, z.object({ email: z.string().email() }));
      const { token } = auth.requestEmailLink(b.email);
      return c.json({ devToken: token, devNote: COPY.emailDevNote });
    });
    app.post("/v1/auth/email/verify", async (c) => {
      const b = await body(c, z.object({ token: z.string().min(1) }));
      try {
        const { accountId, session } = await auth.verifyEmailLink(b.token);
        return c.json({ accountId, sessionId: session.id });
      } catch (e) {
        authErr(e);
      }
    });
  }

  // ───────────────────────── x402 ─────────────────────────

  const requirements = (resource: string, description: string, payTo: Address, amount: string): PaymentRequirements => ({
    scheme: "exact",
    network: escrow.network,
    maxAmountRequired: amount,
    resource: `${deps.publicUrl}${resource}`,
    description,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 600,
    asset: escrow.asset.address,
    extra: { name: escrow.asset.name, version: escrow.asset.version },
  });

  /**
   * Verifies and settles the X-PAYMENT header against `req`. Returns the
   * payment on success, or the 402 response to send. A nonce is claimed
   * before settling, so the same authorization can never be submitted twice.
   */
  const takePayment = async (c: Context<Env>, req: PaymentRequirements): Promise<PaymentPayload | Response> => {
    const refuse = (error?: string) => c.json(paymentRequiredBody([req], error), 402);
    const header = c.req.header("x-payment");
    if (!header) return refuse();
    let payment: PaymentPayload;
    try {
      payment = decodePaymentHeader(header);
    } catch (e) {
      return refuse(e instanceof X402Error ? e.reason : "invalid_payment_payload");
    }
    const verified = await deps.facilitator.verify(payment, req);
    if (!verified.isValid) return refuse(verified.invalidReason ?? "invalid_payment");
    const a = payment.payload.authorization;
    if (!(await deps.nonces.claim(req.network, a.from, a.nonce))) return refuse(COPY.replayed);
    const settled = await deps.facilitator.settle(payment, req);
    if (!settled.success) return refuse(settled.errorReason ?? "settlement_failed");
    c.header("X-PAYMENT-RESPONSE", encodePaymentResponse(settled, req.network));
    return payment;
  };

  /**
   * Pay for a quoted job in one request (§9.2). The payment goes to the job's
   * own forwarder address; refunds go to the address in X-Jelly-Payer, which
   * the caller chooses and which need not be the wallet that pays.
   */
  app.post("/v1/x402/jobs", async (c) => {
    const account = await requireAccount(c);
    const payer = c.req.header("x-jelly-payer");
    if (!payer || !isAddress(payer)) throw new ServiceError("invalid", COPY.payerHeader);
    const { quoteId } = await body(c, z.object({ quoteId: z.string().uuid() }));

    const prepared = await service.prepare(account, quoteId, "x402", payer);
    if (!prepared.payment || prepared.payment.route !== "x402") return c.json({ job: prepared.job });

    const paid = await takePayment(c, requirements("/v1/x402/jobs", COPY.x402Job, prepared.payment.payTo, prepared.payment.amount));
    if (paid instanceof Response) return paid;
    return c.json({ job: await service.confirm(account, prepared.job.jobKey) });
  });

  /** Buy a wallet-bound key and top up that wallet's prepaid balance, minimum $5 (§9.2). */
  app.post("/v1/x402/keys", async (c) => {
    const b = await body(
      c,
      z.object({ owner: z.string().refine((s): s is Address => isAddress(s)), amountUsd: z.string().regex(/^\d+(\.\d{1,6})?$/) }),
    );
    const amount = usd6(b.amountUsd);
    if (amount < usd6("5")) throw new ServiceError("invalid", COPY.topUpMinimum);

    const payTo = await escrow.topUpForwarder(b.owner);
    const paid = await takePayment(c, requirements("/v1/x402/keys", COPY.x402TopUp, payTo, amount.toString()));
    if (paid instanceof Response) return paid;
    await escrow.sweepTopUp(b.owner);
    const issued = await service.issueKey(b.owner);
    return c.json({ keyId: issued.keyId, key: issued.secret, active: false, note: COPY.keyNote }, 201);
  });

  // ───────────────────────── live: WebSocket ─────────────────────────

  /**
   * §11.2 WebSocket, owner channel, multi-job. The client sends
   * `{op:"sub", jobKey}` for each job it wants (ownership is checked per
   * subscription) and `{op:"unsub", jobKey}` to stop; one socket can
   * multiplex many jobs. Needs an access key as a `?key=` query parameter,
   * since the WebSocket handshake carries no custom headers.
   */
  app.get(
    "/v1/ws",
    upgradeWebSocket((c) => {
      const unsubscribers = new Map<Hex, () => void>();
      return {
        onMessage: async (event, ws) => {
          let msg: unknown;
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          const parsed = z
            .object({ op: z.enum(["sub", "unsub"]), jobKey: JobKey })
            .safeParse(msg);
          if (!parsed.success) return;
          const { op, jobKey } = parsed.data;

          if (op === "unsub") {
            unsubscribers.get(jobKey)?.();
            unsubscribers.delete(jobKey);
            return;
          }
          if (unsubscribers.has(jobKey)) return;
          const account = await accountFromRequest(service, c.req.query("key") ? `Bearer ${c.req.query("key")}` : undefined);
          if (!account) return ws.send(JSON.stringify({ error: "forbidden", jobKey }));
          try {
            await service.status(account, jobKey);
          } catch {
            return ws.send(JSON.stringify({ error: "not_found", jobKey }));
          }
          unsubscribers.set(
            jobKey,
            deps.bus.subscribe(jobKey, (e) => ws.send(JSON.stringify({ jobKey, seq: e.seq, type: e.type, payload: e.payload }))),
          );
        },
        onClose: () => {
          for (const unsub of unsubscribers.values()) unsub();
          unsubscribers.clear();
        },
      };
    }),
  );

  // ───────────────────────── discovery ─────────────────────────

  app.get("/.well-known/agent-card.json", (c) =>
    c.json({
      name: COPY.agentName,
      description: COPY.agentDescription,
      url: deps.publicUrl,
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [
        { id: "swarm.quote", name: "Quote", description: COPY.skillQuote },
        { id: "swarm.run", name: "Run", description: COPY.skillRun },
      ],
    }),
  );

  app.get("/.well-known/x402", (c) =>
    c.json({
      x402Version: 1,
      network: escrow.network,
      asset: escrow.asset.address,
      resources: [
        { resource: `${deps.publicUrl}/v1/x402/jobs`, method: "POST", description: COPY.x402Job },
        { resource: `${deps.publicUrl}/v1/x402/keys`, method: "POST", description: COPY.x402TopUp },
      ],
    }),
  );

  // ───────────────────────── stats ─────────────────────────

  if (deps.stats) {
    const statsHandler = async (c: Context<Env>) => {
      const now = (deps.stats!.now ?? Date.now)();
      const days = Math.min(365, Math.max(1, z.coerce.number().int().positive().default(30).parse(c.req.query("days"))));
      const burns = deps.stats!.burns ? await deps.stats!.burns() : [];
      const view = await buildStats(
        { store: deps.stats!.store, studioOperated: deps.stats!.studioOperated, burns },
        { sinceMs: now - days * 24 * 3600 * 1000, untilMs: now },
      );
      return c.json(view);
    };
    app.get("/stats", statsHandler);
    app.get("/stats.json", statsHandler);
  }

  // ───────────────────────── tRPC ─────────────────────────

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      createContext: async (_opts, c) => ({
        service,
        account: await accountFromRequest(service, c.req.header("authorization"), deps.auth),
      }),
    }),
  );

  return app;
}

export { Grant, JobKey };
