import { afterAll, describe, expect, test } from "bun:test";
import { loadInfraEnv } from "@jelly/shared";
import { Redis } from "ioredis";
import { type Address, type Hex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  type Authorization,
  FallbackFacilitator,
  type Facilitator,
  type HttpFacilitator as HttpFacilitatorType,
  LocalEvmFacilitator,
  type LocalEvmFacilitatorDeps,
  MemoryNonceStore,
  type PaymentPayload,
  type PaymentRequirements,
  RedisNonceStore,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  X402Error,
  X402_VERSION,
  checkPayment,
  decodePaymentHeader,
  encodePaymentHeader,
  encodePaymentResponse,
  paymentRequiredBody,
} from "./index";

const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const PAY_TO = "0x000000000000000000000000000000000000fee1" as Address;
const DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: ASSET } as const;

const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:8453",
  maxAmountRequired: "250000",
  resource: "https://api.example/v1/x402/jobs",
  description: "run a job",
  mimeType: "application/json",
  payTo: PAY_TO,
  maxTimeoutSeconds: 600,
  asset: ASSET,
  extra: { name: DOMAIN.name, version: DOMAIN.version },
  ...over,
});

type PartialPublicClient = LocalEvmFacilitatorDeps["publicClient"];
type PartialWalletClient = NonNullable<LocalEvmFacilitatorDeps["walletClient"]>;

async function pay(auth: Partial<Authorization> = {}, signWith: typeof payer = payer): Promise<PaymentPayload> {
  const authorization: Authorization = {
    from: payer.address,
    to: PAY_TO,
    value: "250000",
    validAfter: "0",
    validBefore: "2000000000",
    nonce: keccak256(toBytes("nonce-1")),
    ...auth,
  };
  const signature = await signWith.signTypedData({
    domain: DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: X402_VERSION, scheme: "exact", network: "eip155:8453", payload: { signature, authorization } };
}

describe("payment header", () => {
  test("round-trips through base64 JSON", async () => {
    const payment = await pay();
    const decoded = decodePaymentHeader(encodePaymentHeader(payment));
    expect(decoded).toEqual(payment);
  });

  test("a malformed or schema-invalid header is refused, not thrown past the caller", () => {
    expect(() => decodePaymentHeader("not-base64-json!!")).toThrow(X402Error);
    expect(() => decodePaymentHeader(Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64"))).toThrow(X402Error);
  });

  test("the 402 body lists what to accept", () => {
    const body = paymentRequiredBody([req()], "payment_required");
    expect(body).toEqual({ x402Version: 1, accepts: [req()], error: "payment_required" });
  });

  test("the settlement response round-trips with the network attached", () => {
    const decoded = JSON.parse(Buffer.from(encodePaymentResponse({ success: true, transaction: "0xabc" }, "eip155:8453"), "base64").toString());
    expect(decoded).toEqual({ success: true, transaction: "0xabc", network: "eip155:8453" });
  });
});

describe("checkPayment", () => {
  test("accepts a payment that exactly matches the requirements and is inside its window", async () => {
    expect(checkPayment(await pay(), req(), 1000)).toBeNull();
  });

  test.each([
    ["wrong network", { network: "eip155:1" } as const, {}],
    ["wrong recipient", {}, { to: "0x000000000000000000000000000000000000dEaD" as Address }],
    ["more than required", {}, { value: "260000" }],
    ["less than required", {}, { value: "240000" }],
    ["not yet valid", {}, { validAfter: "5000" }],
    ["already expired", {}, { validBefore: "1000" }],
  ])("rejects %s", async (_name, reqOver, authOver) => {
    expect(checkPayment(await pay(authOver), req(reqOver), 1000)).not.toBeNull();
  });
});

describe("LocalEvmFacilitator", () => {
  function client(opts: { balance?: bigint; used?: boolean } = {}) {
    const calls: unknown[] = [];
    const publicClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        calls.push(functionName);
        if (functionName === "balanceOf") return opts.balance ?? 1_000_000n;
        if (functionName === "authorizationState") return opts.used ?? false;
        throw new Error("unexpected call");
      },
      waitForTransactionReceipt: async () => ({ status: "success" as const }),
    } as unknown as PartialPublicClient;
    return { publicClient, calls };
  }

  test("verifies signature, replay state and balance", async () => {
    const { publicClient } = client();
    const f = new LocalEvmFacilitator({ network: "eip155:8453", publicClient });
    expect(await f.verify(await pay(), req())).toEqual({ isValid: true, payer: payer.address });
  });

  test("rejects a bad signature, an insufficient balance, and an already-used nonce", async () => {
    const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const f = new LocalEvmFacilitator({ network: "eip155:8453", publicClient: client().publicClient });
    expect((await f.verify(await pay({}, other), req())).invalidReason).toBe("invalid_signature");

    const poor = new LocalEvmFacilitator({ network: "eip155:8453", publicClient: client({ balance: 1n }).publicClient });
    expect((await f.verify(await pay(), req({ maxAmountRequired: "9999999" }))).invalidReason).toBe("wrong_amount");
    expect((await poor.verify(await pay(), req())).invalidReason).toBe("insufficient_funds");

    const used = new LocalEvmFacilitator({ network: "eip155:8453", publicClient: client({ used: true }).publicClient });
    expect((await used.verify(await pay(), req())).invalidReason).toBe("authorization_already_used");
  });

  test("without a wallet client, settle refuses rather than silently failing to pay", async () => {
    const f = new LocalEvmFacilitator({ network: "eip155:8453", publicClient: client().publicClient });
    expect(await f.settle(await pay(), req())).toEqual({ success: false, errorReason: "facilitator_cannot_settle" });
  });

  test("settle submits the signature and authorization exactly as given, and only ours pays gas", async () => {
    const { publicClient } = client();
    const written: unknown[] = [];
    const walletClient = {
      account: { address: "0x00000000000000000000000000000000000bee" as Address, type: "json-rpc" as const },
      chain: undefined,
      writeContract: async (args: unknown) => {
        written.push(args);
        return "0xdeadbeef" as Hex;
      },
    } as unknown as PartialWalletClient;
    const f = new LocalEvmFacilitator({ network: "eip155:8453", publicClient, walletClient });
    const payment = await pay();
    const result = await f.settle(payment, req());
    expect(result).toEqual({ success: true, transaction: "0xdeadbeef", payer: payer.address });
    const call = written[0] as { account: { address: Address } };
    expect(call.account.address).toBe("0x00000000000000000000000000000000000bee"); // the facilitator pays gas, never the payer
  });

  test("a reverted transaction is reported, not treated as success", async () => {
    const publicClient = {
      ...client().publicClient,
      waitForTransactionReceipt: async () => ({ status: "reverted" as const }),
    } as unknown as PartialPublicClient;
    const walletClient = {
      account: { address: "0x00000000000000000000000000000000000bee" as Address, type: "json-rpc" as const },
      chain: undefined,
      writeContract: async () => "0xdead" as Hex,
    } as unknown as PartialWalletClient;
    const f = new LocalEvmFacilitator({ network: "eip155:8453", publicClient, walletClient });
    expect(await f.settle(await pay(), req())).toEqual({ success: false, transaction: "0xdead", errorReason: "transaction_reverted" });
  });
});

describe("FallbackFacilitator", () => {
  const ok: Facilitator = { verify: async () => ({ isValid: true }), settle: async () => ({ success: true }) };
  const down: Facilitator = {
    verify: async () => {
      throw new Error("unreachable");
    },
    settle: async () => {
      throw new Error("unreachable");
    },
  };
  const rejects: Facilitator = { verify: async () => ({ isValid: false, invalidReason: "nope" }), settle: async () => ({ success: false }) };

  test("falls back only when the primary is unreachable, not when it gives a clear answer", async () => {
    expect(await new FallbackFacilitator(down, ok).verify(await pay(), req())).toEqual({ isValid: true });
    expect(await new FallbackFacilitator(rejects, ok).verify(await pay(), req())).toEqual({ isValid: false, invalidReason: "nope" });
  });
});

describe("MemoryNonceStore", () => {
  test("a nonce is claimed once per network and payer", async () => {
    const store = new MemoryNonceStore();
    expect(await store.claim("eip155:8453", payer.address, "0xabc")).toBe(true);
    expect(await store.claim("eip155:8453", payer.address, "0xabc")).toBe(false);
    expect(await store.claim("eip155:1", payer.address, "0xabc")).toBe(true);
    expect(await store.claim("eip155:8453", payer.address, "0xdef")).toBe(true);
  });
});

// Needs a reachable Redis (REDIS_URL, default docker-compose); skipped when unreachable unless REQUIRE_INFRA=1.
const redis = new Redis(loadInfraEnv().REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: 5000,
});
redis.on("error", () => {});
const redisUp = await redis.connect().then(() => true, () => false);
if (!redisUp && process.env.REQUIRE_INFRA === "1") throw new Error("REQUIRE_INFRA=1 but Redis is not reachable");
afterAll(() => redis.disconnect());

describe("RedisNonceStore", () => {
  test.skipIf(!redisUp)("behaves the same as the in-memory store: once per network and payer", async () => {
    const store = new RedisNonceStore(redis, `x402test:${process.pid}:${Date.now()}:`);
    expect(await store.claim("eip155:8453", payer.address, "0xabc")).toBe(true);
    expect(await store.claim("eip155:8453", payer.address, "0xabc")).toBe(false);
    expect(await store.claim("eip155:1", payer.address, "0xabc")).toBe(true);
    expect(await store.claim("eip155:8453", payer.address, "0xdef")).toBe(true);
  });
});

void (null as unknown as HttpFacilitatorType); // referenced only for the export's type shape
