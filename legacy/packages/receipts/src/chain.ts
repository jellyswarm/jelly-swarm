import { type Address, type Hex, hashTypedData, verifyTypedData } from "viem";
import { merkleRoot } from "./merkle";
import {
  type Attestation,
  RECEIPT_TYPES,
  type Receipt,
  type ReceiptDomainParams,
  type Seal,
  type SignedReceipt,
  ZERO32,
  receiptDomain,
} from "./types";

/** Everything the caller supplies; the chain assigns stepIdx and prevHash. */
export type ReceiptBody = Omit<Receipt, "stepIdx" | "prevHash">;

/** A viem LocalAccount satisfies this. In production the key lives in a CPU TEE. */
export interface ReceiptSigner {
  address: Address;
  signTypedData(args: {
    domain: ReturnType<typeof receiptDomain>;
    types: typeof RECEIPT_TYPES;
    primaryType: "Receipt";
    message: Receipt;
  }): Promise<Hex>;
}

export function receiptLeaf(domain: ReceiptDomainParams, receipt: Receipt): Hex {
  return hashTypedData({
    domain: receiptDomain(domain),
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: receipt,
  });
}

type JobChain = { receipts: SignedReceipt[]; tail: Promise<unknown> };

/**
 * Builds the per-job hash chain: leaf_k = hashTypedData(receipt_k) and
 * prevHash_k = leaf_{k-1}. Appends for one job are serialised, so up to 247
 * workers can emit concurrently and step numbers stay strictly sequential.
 *
 * State is held in this process. One job's receipts must therefore all pass
 * through one ReceiptChain instance (the receipt-service, from Phase 6 on).
 */
export class ReceiptChain {
  private readonly jobs = new Map<Hex, JobChain>();

  constructor(
    readonly domain: ReceiptDomainParams,
    private readonly signer: ReceiptSigner,
  ) {}

  get signerAddress(): Address {
    return this.signer.address;
  }

  append(body: ReceiptBody, extras: { nodeSignature?: Hex; attestation?: Attestation } = {}): Promise<SignedReceipt> {
    let job = this.jobs.get(body.jobKey);
    if (!job) {
      job = { receipts: [], tail: Promise.resolve() };
      this.jobs.set(body.jobKey, job);
    }
    const chain = job;
    const next = chain.tail.then(async () => {
      const prev = chain.receipts.at(-1);
      const receipt: Receipt = { ...body, stepIdx: chain.receipts.length, prevHash: prev?.leaf ?? ZERO32 };
      const signature = await this.signer.signTypedData({
        domain: receiptDomain(this.domain),
        types: RECEIPT_TYPES,
        primaryType: "Receipt",
        message: receipt,
      });
      const signed: SignedReceipt = { ...receipt, leaf: receiptLeaf(this.domain, receipt), signature, ...extras };
      chain.receipts.push(signed);
      return signed;
    });
    // A failed append must not block later ones; the caller still sees the error.
    chain.tail = next.catch(() => {});
    return next;
  }

  receipts(jobKey: Hex): readonly SignedReceipt[] {
    return this.jobs.get(jobKey)?.receipts ?? [];
  }

  /** Waits for in-flight appends, then returns (root, count, head) for ReceiptRoot.seal. */
  async seal(jobKey: Hex): Promise<Seal> {
    await this.jobs.get(jobKey)?.tail;
    return sealOf(this.receipts(jobKey));
  }

  /** Drops a job's in-memory chain once it has been sealed and stored. */
  forget(jobKey: Hex): void {
    this.jobs.delete(jobKey);
  }
}

export function sealOf(receipts: readonly SignedReceipt[]): Seal {
  const leaves = receipts.map((r) => r.leaf);
  return { root: merkleRoot(leaves), count: leaves.length, head: leaves.at(-1) ?? ZERO32 };
}

export type VerifyResult = { ok: true; seal: Seal } | { ok: false; stepIdx: number; reason: string };

/**
 * Recomputes every leaf, the chain links, step order and signatures. This is
 * the core of the `jelly-verify` CLI; comparing the seal with the on-chain
 * ReceiptRoot is done by the caller.
 */
export async function verifyChain(
  receipts: readonly SignedReceipt[],
  domain: ReceiptDomainParams,
  signer: Address,
): Promise<VerifyResult> {
  let prev: Hex = ZERO32;
  const jobKey = receipts[0]?.jobKey;
  for (const [i, r] of receipts.entries()) {
    const fail = (reason: string): VerifyResult => ({ ok: false, stepIdx: i, reason });
    if (r.jobKey !== jobKey) return fail("receipt belongs to a different job");
    if (r.stepIdx !== i) return fail(`step index ${r.stepIdx} is out of sequence`);
    if (r.prevHash.toLowerCase() !== prev.toLowerCase()) return fail("prevHash does not match the previous leaf");
    const { leaf, signature, nodeSignature: _n, attestation: _a, ...receipt } = r;
    const expected = receiptLeaf(domain, receipt);
    if (expected.toLowerCase() !== leaf.toLowerCase()) return fail("leaf does not match the receipt fields");
    const signed = await verifyTypedData({
      address: signer,
      domain: receiptDomain(domain),
      types: RECEIPT_TYPES,
      primaryType: "Receipt",
      message: receipt,
      signature,
    }).catch(() => false);
    if (!signed) return fail("signature is not from the receipt key");
    prev = expected;
  }
  return { ok: true, seal: sealOf(receipts) };
}
