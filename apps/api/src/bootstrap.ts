import { randomBytes } from "node:crypto";
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
import { type Escrow, JobService, MemoryEscrow, ViemEscrow, type ViemEscrowAddresses } from "@jelly/service";
import { loadInfraEnv } from "@jelly/shared";
import { NullFundingGraph } from "@jelly/settlement";
import { MemoryTemplateRegistry } from "@jelly/templates";
import { EvmChainReader, EvmOnlyAccountInspector, WORKER_MANIFEST, WorkerTools } from "@jelly/tools";
import { FallbackFacilitator, LocalEvmFacilitator, RedisNonceStore } from "@jelly/x402";
import { Redis } from "ioredis";
import { type Address, type Hex, type PublicClient, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, websocket } from "./app";
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
  });

  // ── x402 payment facilitation ──
  const relayerAccount = privateKeyToAccount(requireHex("RELAYER_PRIVATE_KEY", process.env.RELAYER_PRIVATE_KEY ?? signerKey));
  const relayerWallet = publicClient ? createWalletClient({ account: relayerAccount, transport: http(rpcUrl!) }) : undefined;
  const facilitator = new FallbackFacilitator(
    new LocalEvmFacilitator({ network: escrow.network, publicClient: publicClient ?? neverPublicClient(), ...(relayerWallet ? { walletClient: relayerWallet } : {}) }),
    new LocalEvmFacilitator({ network: escrow.network, publicClient: neverPublicClient() }),
  );
  const nonces = new RedisNonceStore(redis);

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
    onError: (e) => console.error("[api] internal error:", e),
    stats: { store, studioOperated: true },
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:4173,http://127.0.0.1:4173").split(",").map((s) => s.trim()).filter(Boolean),
    devFunding,
    watches,
    auth,
  });

  // ── settlement-keeper: finalize, audit sampling, and the referral/volume hooks nothing else calls ──
  const keeper = startKeeper({
    store,
    escrow,
    classify: { studioWallets: new Set(), graph: new NullFundingGraph() },
    onEvent: (e) => {
      if (e.type === "finalized") service.onJobFinalized(e.jobKey).catch((err) => console.error("[bootstrap] onJobFinalized failed:", err));
      if (e.type === "keeper_error") console.error("[bootstrap] settlement-keeper tick failed:", e.error);
    },
  });

  for (const w of warnings) console.warn(`[bootstrap] ${w}`);
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
