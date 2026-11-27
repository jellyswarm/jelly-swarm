import { randomBytes } from "node:crypto";
import { ProofOfWork, RedisBanStore, RedisCachedAsnLookup, RedisPowStore, RedisWindowCounter, RipeAsnLookup } from "@jelly/abuse";
import { AuthService, RealPasskeyVerifier } from "@jelly/auth";
import { RedisBudgetStore } from "@jelly/budget-guard";
import { Checker } from "@jelly/checker";
import { PgAccountStore, PgJobStore, PgSessionStore, PgWatchStore, createDb } from "@jelly/db";
import { Engine, JobGuards, Quoter, RedisSemaphore, runRow } from "@jelly/engine";
import { Fetcher } from "@jelly/fetcher";
import { Gateway, type HostInput, OpenAICompatProvider } from "@jelly/gateway";
import { startKeeper } from "@jelly/keeper";
import { InMemoryEventBus } from "@jelly/live";
import { Merger } from "@jelly/merger";
import { ReceiptChain, ZERO32 } from "@jelly/receipts";
import { type Escrow, JobService, MemoryEscrow, signGrant, ViemEscrow, type ViemEscrowAddresses } from "@jelly/service";
import { FREE_TIER, loadInfraEnv } from "@jelly/shared";
import { NullFundingGraph, RedisIpHistory } from "@jelly/settlement";
import { MemoryTemplateRegistry } from "@jelly/templates";
import { EvmChainReader, EvmOnlyAccountInspector, WORKER_MANIFEST, WorkerTools } from "@jelly/tools";
import { FallbackFacilitator, LocalEvmFacilitator, RedisNonceStore } from "@jelly/x402";
import { Redis } from "ioredis";
import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, websocket } from "./app";
import { logger } from "./logger";
import { ResendMailer } from "./mailer";
import { defaultModelHost } from "./model-hosts";

/**
 * Builds every real, non-test implementation into one running `JobService`
 * + Hono app, reading all configuration from the environment (day1.md
 * #23). Postgres and Redis are required (this app has nowhere useful to
 * fall back to without them); chain/contract and model-host config are
 * optional and fall back to a safe, explicitly-logged stand-in, so this
 * starts and serves quotes-with-no-live-model or memory-escrow runs even
 * before every credential exists.
 *
 * `@jelly/auth` and `@jelly/abuse`'s real stores (PgSessionStore,
 * RealPasskeyVerifier, RedisBanStore, RedisPowStore, RedisWindowCounter)
 * are not wired in here: `./app.ts` exposes no sign-in or abuse-checking
 * HTTP routes yet to call them from. That is a separate gap from this
 * bootstrap, which only wires what `createApp`'s `AppDeps` actually needs.
 */
export async function buildApp() {
  const env = loadInfraEnv();
  const warnings: string[] = [];
  const masterApiKey = process.env.MASTER_API_KEY;
  if (!masterApiKey || masterApiKey.length < 32) {
    throw new Error("MASTER_API_KEY must be set to a random value of at least 32 characters");
  }

  // ── infra ──
  const { db } = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

  // ── sign-in: passkey, email link, external wallet (§10.1) ──
  const authOrigin = process.env.AUTH_ORIGIN ?? "http://localhost:4173";
  const authRpId = process.env.AUTH_RP_ID ?? new URL(authOrigin).hostname;
  const auth = new AuthService({
    accounts: new PgAccountStore(db),
    sessions: new PgSessionStore(db),
    passkeyVerifier: new RealPasskeyVerifier(),
    deviceSecret: process.env.DEVICE_SECRET ?? devSecret("DEVICE_SECRET", warnings),
    emailPepper: process.env.EMAIL_PEPPER ?? devSecret("EMAIL_PEPPER", warnings),
    siweDomain: process.env.AUTH_SIWE_DOMAIN ?? authRpId,
    rpId: authRpId,
    origin: authOrigin,
  });
  const webUrl = process.env.WEB_PUBLIC_URL ?? authOrigin;
  const mailer = process.env.RESEND_API_KEY ? new ResendMailer(process.env.RESEND_API_KEY) : undefined;
  if (!mailer) warnings.push("RESEND_API_KEY is not set: email sign-in dev-bypasses the mailer, returning the link token directly in the response.");

  // ── model routing ──
  const signerKey = requireHex("SIGNER_PRIVATE_KEY", process.env.SIGNER_PRIVATE_KEY);
  const signer = privateKeyToAccount(signerKey);
  const receipts = new ReceiptChain(
    {
      chainId: Number(process.env.CHAIN_ID ?? 8453),
      verifyingContract: addressEnv("RECEIPT_ROOT_ADDRESS", signer.address),
      salt: (process.env.RECEIPT_DOMAIN_SALT as Hex | undefined) ?? ZERO32,
    },
    signer,
  );

  const modelApiKey = process.env.OPEN_ROUTER_API_KEY ?? process.env.MODEL_HOST_API_KEY;
  const modelBaseUrl = process.env.MODEL_HOST_BASE_URL ?? "https://openrouter.ai/api/v1";
  const host = defaultModelHost(modelApiKey, modelBaseUrl);
  const hosts: HostInput[] = host ? [host] : [];
  if (hosts.length === 0) {
    warnings.push("OPEN_ROUTER_API_KEY is not set: no model host is configured, so every quote/run will fail to route until one is.");
  }
  const provider = new OpenAICompatProvider({ apiKeys: modelApiKey && host ? { [host.id]: modelApiKey } : {} });
  const budget = new RedisBudgetStore(redis);
  const gateway = new Gateway({ hosts, provider, budget, limits: BUDGET_LIMITS, receipts, requireConfirmedPrices: false });

  // ── chain reads, fetching and tools the workers/checker use ──
  const rpcUrl = process.env.RPC_URL_BASE;
  const publicClient: PublicClient | undefined = rpcUrl ? createPublicClient({ transport: http(rpcUrl) }) : undefined;
  const chainReader = publicClient ? new EvmChainReader({ base: publicClient }) : new EvmChainReader({});
  const inspector = publicClient ? new EvmOnlyAccountInspector({ base: publicClient }) : new EvmOnlyAccountInspector({});
  if (!publicClient) warnings.push("RPC_URL_BASE is not set: chain_read and wallet-vs-contract detection will fail closed.");
  const fetcher = new Fetcher();
  const tools = new WorkerTools({ fetcher, chain: chainReader });
  const checker = new Checker({ gateway, fetcher, chain: chainReader });

  // ── settlement chain: Escrow ──
  const escrow = buildEscrow(publicClient, warnings);

  // ── free tier: the studio pays from its own vault balance, never the caller's (§10.3) ──
  const studioAccount = privateKeyToAccount(requireHex("STUDIO_PRIVATE_KEY", process.env.STUDIO_PRIVATE_KEY ?? signerKey));
  const studioGrant = await signGrant(studioAccount, escrow.grantDomain(), {
    owner: studioAccount.address,
    keyId: ZERO32,
    perJobCapUsd6: FREE_TIER.maxQuoteUsd6,
    perDayCapUsd6: 50_000_000n, // the studio's own daily free-tier budget, not a per-caller limit
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600),
    periodCapUsd6: 0n,
    minCoverageBps: 0,
  });
  // §11.4 paying with a credit balance: same studio vault, a separate keyId so its daily spend
  // cap is tracked apart from the free tier's — a burst of credit-funded jobs should never eat
  // into the free tier's budget, or the other way around.
  const creditsGrant = await signGrant(studioAccount, escrow.grantDomain(), {
    owner: studioAccount.address,
    keyId: `0x${"01".repeat(32)}` as Hex,
    perJobCapUsd6: 50_000_000n, // $50 — well above any plausible accumulated credit balance
    perDayCapUsd6: 500_000_000n, // $500/day studio-wide, across every credits-funded job
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600),
    periodCapUsd6: 0n,
    minCoverageBps: 0,
  });
  if (escrow instanceof MemoryEscrow) {
    escrow.vault.set(studioAccount.address.toLowerCase(), 100_000_000_000n); // dev-only: a MemoryEscrow vault has no real money to run out of
  } else {
    warnings.push(
      "Free-tier and credits-funded jobs are signed for, but the studio's BalanceVault balance must actually be funded on-chain for either to run — this only signs the grants, it never deposits anything.",
    );
  }

  // ── quoting ──
  const quoterAccount = privateKeyToAccount(requireHex("QUOTER_PRIVATE_KEY", process.env.QUOTER_PRIVATE_KEY ?? signerKey));
  let dryRuns = 0;
  const quoter = new Quoter({
    signer: quoterAccount,
    inspector,
    runSample: async (spec, itemIdx, walletJob) => {
      const out = await runRow({
        gateway,
        job: {
          jobKey: `0x${(++dryRuns).toString(16).padStart(64, "0")}` as Hex,
          product: spec.product,
          tier: spec.tier,
          walletJob,
          accountId: "studio:dry-run",
          lane: "paid",
          freeTier: false,
          quoteMicros: 50_000n,
        },
        spec,
        rowIdx: itemIdx,
        slot: 1,
        manifest: WORKER_MANIFEST,
        tools,
        guards: new JobGuards(0n),
        receipts,
      });
      return { costMicros: out.costMicros, toolsUsd6: out.toolsUsd6 };
    },
  });

  const store = new PgJobStore(db);
  const bus = new InMemoryEventBus();
  const templates = new MemoryTemplateRegistry();
  const semaphore = new RedisSemaphore(redis);
  const watches = new PgWatchStore(db);

  const service = new JobService({
    quoter,
    quoterAddress: quoterAccount.address,
    makeEngine: (onEvent) =>
      new Engine({ gateway, checker: checker.asRowChecker(), workerManifest: WORKER_MANIFEST, tools, receipts, semaphore, onEvent }),
    merger: new Merger({ gateway }),
    receipts,
    store,
    escrow,
    bus,
    verdictSigner: signer,
    templates,
    studioGrant,
    creditsGrant,
  });

  // ── x402 payment facilitation ──
  const relayerAccount = privateKeyToAccount(requireHex("RELAYER_PRIVATE_KEY", process.env.RELAYER_PRIVATE_KEY ?? signerKey));
  const relayerWallet = publicClient ? createWalletClient({ account: relayerAccount, transport: http(rpcUrl!) }) : undefined;
  const facilitator = new FallbackFacilitator(
    new LocalEvmFacilitator({ network: escrow.network, publicClient: publicClient ?? neverPublicClient(), ...(relayerWallet ? { walletClient: relayerWallet } : {}) }),
    new LocalEvmFacilitator({ network: escrow.network, publicClient: neverPublicClient() }),
  );
  const nonces = new RedisNonceStore(redis);

  // ── free-tier abuse resistance (§10.3): PoW, device/IP rate buckets, and ban escalation ──
  const bans = new RedisBanStore(redis);
  const pow = new ProofOfWork(new RedisPowStore(redis));
  const rateLimits = new RedisWindowCounter(redis);
  // stat.ripe.net: free, public, no API key. Caches each address's ASN in Redis for a day.
  const asnLookup = new RedisCachedAsnLookup(new RipeAsnLookup(), redis);

  const devFunding = escrow instanceof MemoryEscrow;
  if (devFunding) {
    warnings.push("Dev-only funding is enabled (POST /v1/jobs/:key/dev-fund): escrow is MemoryEscrow, so this moves no real money.");
  }
  const app = createApp({
    service,
    escrow,
    bus,
    store,
    facilitator,
    nonces,
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:3000",
    masterApiKey,
    onError: (e) => logger.error({ err: e }, "internal error"),
    stats: { store, studioOperated: true },
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:4173,http://127.0.0.1:4173").split(",").map((s) => s.trim()).filter(Boolean),
    devFunding,
    watches,
    auth,
    webUrl,
    ipHistory: new RedisIpHistory(redis),
    freeTier: { bans, pow, rateLimits, asnLookup },
    ...(mailer ? { mailer } : {}),
  });

  // ── settlement-keeper: finalize, audit sampling, and the referral/volume hooks nothing else calls ──
  const keeper = startKeeper({
    store,
    escrow,
    classify: { studioWallets: new Set(), graph: new NullFundingGraph() },
    onEvent: (e) => {
      if (e.type === "finalized") {
        service.onJobFinalized(e.jobKey).catch((err) => logger.error({ err, jobKey: e.jobKey }, "onJobFinalized failed"));
      }
      if (e.type === "keeper_error") logger.error({ err: e.error }, "settlement-keeper tick failed");
    },
  });

  for (const w of warnings) logger.warn(w);
  return {
    app,
    websocket,
    close: async () => {
      keeper.stop();
      redis.disconnect();
    },
  };
}

const BUDGET_LIMITS = {
  accountDayMicros: 500_000_000_000n,
  laneDayMicros: { priority: 5_000_000_000_000n, paid: 5_000_000_000_000n, free: 500_000_000_000n, deferred: 500_000_000_000n },
  globalDayMicros: 50_000_000_000_000n,
  freeTierDayMicros: 500_000_000_000n,
};

/** A random per-process secret, so this starts without the env var set. Every session and email-link token issued before a restart becomes invalid after one — fine for dev, never for production. */
function devSecret(name: string, warnings: string[]): string {
  warnings.push(`${name} is not set: using a random secret for this process only. Sessions and email links issued before a restart will not survive one.`);
  return randomBytes(32).toString("hex");
}

function requireHex(name: string, value: string | undefined): Hex {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be set to a 32-byte hex private key to start this app`);
  }
  return value as Hex;
}

function addressEnv(name: string, fallback: Address): Address {
  const v = process.env[name];
  return (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : fallback) as Address;
}

function buildEscrow(publicClient: PublicClient | undefined, warnings: string[]): Escrow {
  const addrs: Partial<ViemEscrowAddresses> = {
    jellyJob: process.env.ESCROW_JELLY_JOB as Address,
    rowSplit: process.env.ESCROW_ROW_SPLIT as Address,
    receiptRoot: process.env.ESCROW_RECEIPT_ROOT as Address,
    balanceVault: process.env.ESCROW_BALANCE_VAULT as Address,
    forwarderFactory: process.env.ESCROW_FORWARDER_FACTORY as Address,
  };
  const complete = publicClient && Object.values(addrs).every((a) => a && /^0x[0-9a-fA-F]{40}$/.test(a));
  if (!complete || !publicClient) {
    warnings.push(
      "Chain/contract config is incomplete (RPC_URL_BASE + every ESCROW_* address): using MemoryEscrow, which moves no real money. " +
        "Set those once contracts are deployed on the target chain (see contracts/script/Deploy.s.sol).",
    );
    return new MemoryEscrow();
  }
  const usdAddress = process.env.ESCROW_USD_ADDRESS as Address;
  const roleKey = (name: string) => privateKeyToAccount(requireHex(name, process.env[name] ?? process.env.SIGNER_PRIVATE_KEY));
  const rpcUrl = process.env.RPC_URL_BASE!;
  return new ViemEscrow({
    chain: (process.env.ESCROW_CHAIN_KEY as "base" | "rhc") ?? "base",
    chainId: Number(process.env.CHAIN_ID ?? 8453),
    network: `eip155:${process.env.CHAIN_ID ?? 8453}`,
    asset: {
      address: usdAddress,
      symbol: process.env.ESCROW_ASSET_SYMBOL ?? "USDC",
      name: process.env.ESCROW_ASSET_NAME ?? "USD Coin",
      version: process.env.ESCROW_ASSET_VERSION ?? "2",
    },
    publicClient,
    quoterWallet: createWalletClient({ account: roleKey("QUOTER_PRIVATE_KEY"), transport: http(rpcUrl) }),
    keeperWallet: createWalletClient({ account: roleKey("KEEPER_PRIVATE_KEY"), transport: http(rpcUrl) }),
    sealerWallet: createWalletClient({ account: roleKey("SEALER_PRIVATE_KEY"), transport: http(rpcUrl) }),
    relayerWallet: createWalletClient({ account: roleKey("RELAYER_PRIVATE_KEY"), transport: http(rpcUrl) }),
    addresses: addrs as ViemEscrowAddresses,
  });
}

/** A PublicClient that is never actually called: used only when no RPC is configured, so x402 verify-only wiring still type-checks. */
function neverPublicClient(): Pick<PublicClient, "readContract" | "waitForTransactionReceipt"> {
  const fail = () => Promise.reject(new Error("no RPC configured (set RPC_URL_BASE)"));
  return { readContract: fail, waitForTransactionReceipt: fail } as unknown as Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;
}
