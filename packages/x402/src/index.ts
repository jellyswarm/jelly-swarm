import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  isAddress,
  parseSignature,
  verifyTypedData,
} from "viem";
import { z } from "zod";

/**
 * x402: pay-per-request over HTTP (§9.2). A request without payment gets a
 * 402 listing what to pay and where; the client retries with an `X-PAYMENT`
 * header carrying a signed transfer authorization; a facilitator verifies and
 * settles it.
 *
 * This covers the "exact" scheme on EVM chains, where the payment is an
 * EIP-3009 `transferWithAuthorization` on the stablecoin. Written from the
 * protocol's published shape; run it against a real x402 client before
 * launch. The Solana path arrives with the Solana program in Phase 8.
 */
export const X402_VERSION = 1 as const;

export type PaymentRequirements = {
  scheme: "exact";
  /** CAIP-2 network id, e.g. "eip155:8453". */
  network: string;
  /** Amount in the asset's smallest unit, as a decimal string. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  /** Where the payment goes: the job's intake forwarder. */
  payTo: string;
  maxTimeoutSeconds: number;
  /** The stablecoin contract. */
  asset: string;
  /** EIP-712 domain of the asset, needed to verify the authorization. */
  extra: { name: string; version: string };
};

const HexString = z.string().regex(/^0x[0-9a-fA-F]*$/) as unknown as z.ZodType<Hex>;
const EvmAddress = z.string().refine((s) => isAddress(s), "not an address") as unknown as z.ZodType<Address>;
const Uint = z.string().regex(/^\d{1,78}$/);

export const Authorization = z.object({
  from: EvmAddress,
  to: EvmAddress,
  value: Uint,
  validAfter: Uint,
  validBefore: Uint,
  nonce: HexString.refine((h) => h.length === 66, "nonce must be 32 bytes"),
});
export type Authorization = z.infer<typeof Authorization>;

export const PaymentPayload = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: z.literal("exact"),
  network: z.string().min(1),
  payload: z.object({ signature: HexString, authorization: Authorization }),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

export class X402Error extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "X402Error";
  }
}

/** Body of a 402 response. */
export const paymentRequiredBody = (accepts: PaymentRequirements[], error?: string) => ({
  x402Version: X402_VERSION,
  accepts,
  ...(error ? { error } : {}),
});

/** Parses the base64 JSON `X-PAYMENT` header. */
export function decodePaymentHeader(header: string): PaymentPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new X402Error("malformed_payment_header");
  }
  const parsed = PaymentPayload.safeParse(json);
  if (!parsed.success) throw new X402Error("invalid_payment_payload");
  return parsed.data;
}

export const encodePaymentHeader = (p: PaymentPayload): string => Buffer.from(JSON.stringify(p)).toString("base64");

export type SettleResult = { success: boolean; transaction?: string; payer?: string; errorReason?: string };

/** Value of the `X-PAYMENT-RESPONSE` header. */
export const encodePaymentResponse = (r: SettleResult, network: string): string =>
  Buffer.from(JSON.stringify({ ...r, network })).toString("base64");

/**
 * Checks that need no chain access: the payment is for this network, pays
 * exactly the required amount to the required address, and is inside its
 * validity window. Returns the reason it is invalid, or null.
 */
export function checkPayment(payment: PaymentPayload, req: PaymentRequirements, nowSec: number): string | null {
  const a = payment.payload.authorization;
  if (payment.network !== req.network) return "wrong_network";
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return "wrong_recipient";
  // "exact": not less, and not more either, so nothing is left stranded.
  if (BigInt(a.value) !== BigInt(req.maxAmountRequired)) return "wrong_amount";
  if (BigInt(a.validAfter) > BigInt(nowSec)) return "not_yet_valid";
  // Leave room for the transaction to land before the authorization lapses.
  if (BigInt(a.validBefore) <= BigInt(nowSec) + 5n) return "expired";
  return null;
}

export type VerifyResult = { isValid: boolean; invalidReason?: string; payer?: string };

export interface Facilitator {
  verify(payment: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult>;
  settle(payment: PaymentPayload, req: PaymentRequirements): Promise<SettleResult>;
}

const chainIdOf = (network: string): number => {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new X402Error("unsupported_network");
  return Number(m[1]);
};

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const typedMessage = (a: Authorization) => ({
  from: a.from,
  to: a.to,
  value: BigInt(a.value),
  validAfter: BigInt(a.validAfter),
  validBefore: BigInt(a.validBefore),
  nonce: a.nonce,
});

/**
 * Our own facilitator for one EVM chain. It only ever submits the payer's
 * signed authorization as written: the money moves from the payer to
 * `payTo`, and this key pays gas. It never holds the funds.
 */
export type LocalEvmFacilitatorDeps = {
  network: string;
  publicClient: Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;
  /** Gas-paying key. Omit to run verify-only. */
  walletClient?: Pick<WalletClient, "writeContract" | "account" | "chain">;
  now?: () => number;
};

export class LocalEvmFacilitator implements Facilitator {
  constructor(
    private readonly deps: LocalEvmFacilitatorDeps,
  ) {}

  async verify(payment: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
    const nowSec = Math.floor((this.deps.now ?? Date.now)() / 1000);
    if (req.network !== this.deps.network) return { isValid: false, invalidReason: "unsupported_network" };
    const reason = checkPayment(payment, req, nowSec);
    if (reason) return { isValid: false, invalidReason: reason };

    const a = payment.payload.authorization;
    const asset = req.asset as Address;
    const signed = await verifyTypedData({
      address: a.from,
      domain: { name: req.extra.name, version: req.extra.version, chainId: chainIdOf(req.network), verifyingContract: asset },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: typedMessage(a),
      signature: payment.payload.signature,
    }).catch(() => false);
    if (!signed) return { isValid: false, invalidReason: "invalid_signature" };

    try {
      const [balance, used] = await Promise.all([
        this.deps.publicClient.readContract({ address: asset, abi: EIP3009_ABI, functionName: "balanceOf", args: [a.from] }),
        this.deps.publicClient.readContract({
          address: asset,
          abi: EIP3009_ABI,
          functionName: "authorizationState",
          args: [a.from, a.nonce],
        }),
      ]);
      if (used) return { isValid: false, invalidReason: "authorization_already_used" };
      if (balance < BigInt(a.value)) return { isValid: false, invalidReason: "insufficient_funds" };
    } catch {
      return { isValid: false, invalidReason: "asset_read_failed" };
    }
    return { isValid: true, payer: a.from };
  }

  async settle(payment: PaymentPayload, req: PaymentRequirements): Promise<SettleResult> {
    const wallet = this.deps.walletClient;
    if (!wallet?.account) return { success: false, errorReason: "facilitator_cannot_settle" };
    const check = await this.verify(payment, req);
    if (!check.isValid) return { success: false, errorReason: check.invalidReason ?? "invalid_payment" };

    const a = payment.payload.authorization;
    const sig = parseSignature(payment.payload.signature);
    try {
      const hash = await wallet.writeContract({
        account: wallet.account,
        chain: wallet.chain ?? null,
        address: req.asset as Address,
        abi: EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [
          a.from,
          a.to,
          BigInt(a.value),
          BigInt(a.validAfter),
          BigInt(a.validBefore),
          a.nonce,
          Number(sig.v ?? (sig.yParity === 0 ? 27n : 28n)),
          sig.r,
          sig.s,
        ],
      });
      const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return { success: false, transaction: hash, errorReason: "transaction_reverted" };
      return { success: true, transaction: hash, payer: a.from };
    } catch {
      return { success: false, errorReason: "settlement_failed" };
    }
  }
}

/**
 * A third-party facilitator reached over HTTP (`POST /verify`, `POST /settle`).
 * Used as the fallback on Base and Solana (§7). Its URL is a day-1 check.
 */
export class HttpFacilitator implements Facilitator {
  constructor(private readonly opts: { url: string; fetch?: typeof fetch; timeoutMs?: number }) {}

  private async post<T>(path: string, payment: PaymentPayload, req: PaymentRequirements): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.url.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: req }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new X402Error(`facilitator_http_${res.status}`);
    return (await res.json()) as T;
  }

  async verify(payment: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
    const r = await this.post<VerifyResult>("/verify", payment, req);
    return { isValid: r.isValid === true, ...(r.invalidReason ? { invalidReason: r.invalidReason } : {}), ...(r.payer ? { payer: r.payer } : {}) };
  }

  async settle(payment: PaymentPayload, req: PaymentRequirements): Promise<SettleResult> {
    const r = await this.post<SettleResult>("/settle", payment, req);
    return { success: r.success === true, ...(r.transaction ? { transaction: r.transaction } : {}), ...(r.payer ? { payer: r.payer } : {}), ...(r.errorReason ? { errorReason: r.errorReason } : {}) };
  }
}

/**
 * Tries the primary facilitator; if it is unreachable (throws), uses the
 * fallback. A clear "invalid" or "failed" answer is final and is not retried
 * elsewhere, so one payment is never submitted twice.
 */
export class FallbackFacilitator implements Facilitator {
  constructor(
    private readonly primary: Facilitator,
    private readonly fallback: Facilitator,
  ) {}

  verify(payment: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
    return this.primary.verify(payment, req).catch(() => this.fallback.verify(payment, req));
  }

  settle(payment: PaymentPayload, req: PaymentRequirements): Promise<SettleResult> {
    return this.primary.settle(payment, req).catch(() => this.fallback.settle(payment, req));
  }
}

/**
 * Replay guard. An authorization nonce is accepted once per network; a
 * second request carrying it is refused before anything is settled.
 */
export interface NonceStore {
  /** Returns true the first time a (network, payer, nonce) is seen, false afterwards. */
  claim(network: string, payer: string, nonce: string): Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Set<string>();

  async claim(network: string, payer: string, nonce: string): Promise<boolean> {
    const key = `${network}:${payer.toLowerCase()}:${nonce.toLowerCase()}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
