import type { Address, Hex } from "viem";

/** §4. One receipt per model or paid-tool call. */
export type Receipt = {
  /** keccak(chainId, JellyJob, jobId) on EVM, or the Solana job key. */
  jobKey: Hex;
  /** Strictly sequential per job, starting at 0. */
  stepIdx: number;
  agentId: number;
  role: number;
  /** NO_ROW when the call is not tied to a row. */
  rowIdx: number;
  /** Leaf of the previous receipt; ZERO32 for step 0. */
  prevHash: Hex;
  /** keccak(canonical JSON of messages + tool args). */
  inputHash: Hex;
  toolCallsHash: Hex;
  /** keccak(model id), e.g. keccak("deepseek-v4-flash"). */
  modelId: Hex;
  /** keccak(host label), e.g. keccak("phala") or keccak("node:<operatorId>"). */
  host: Hex;
  costMicros: bigint;
  outputHash: Hex;
  /** Sealed: keccak(x-receipt-id ‖ TDX quote hash). Open/Standard: ZERO32 (studio-signed only). */
  attestationRef: Hex;
};

export const ZERO32: Hex = `0x${"00".repeat(32)}`;
export const NO_ROW = 0xffffffff;

/**
 * Agent ids written into receipts. The build doc fixes 0 = planner,
 * 1..247 = worker slot and 900+ = checker; the remaining ranges are cut off in
 * the source PDF, so merger / spotter / intake below are our assignment.
 */
export const AGENT_ID = {
  planner: 0,
  /** Worker slot n (1..247). */
  worker: (slot: number): number => {
    if (!Number.isInteger(slot) || slot < 1 || slot > 247) throw new Error(`worker slot out of range: ${slot}`);
    return slot;
  },
  checker: (n = 0): number => 900 + n,
  merger: 950,
  spotter: 960,
  intake: 980,
} as const;

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "jobKey", type: "bytes32" },
    { name: "stepIdx", type: "uint32" },
    { name: "agentId", type: "uint32" },
    { name: "role", type: "uint8" },
    { name: "rowIdx", type: "uint32" },
    { name: "prevHash", type: "bytes32" },
    { name: "inputHash", type: "bytes32" },
    { name: "toolCallsHash", type: "bytes32" },
    { name: "modelId", type: "bytes32" },
    { name: "host", type: "bytes32" },
    { name: "costMicros", type: "uint64" },
    { name: "outputHash", type: "bytes32" },
    { name: "attestationRef", type: "bytes32" },
  ],
} as const;

/** Per-deployment EIP-712 domain parameters. `salt` is the per-product salt. */
export type ReceiptDomainParams = { chainId: number; verifyingContract: Address; salt: Hex };

export const receiptDomain = (p: ReceiptDomainParams) =>
  ({ name: "JellySwarm Receipts", version: "1", ...p }) as const;

/** Raw hardware attestation, kept in the transcript beside the receipt. */
export type Attestation = { receiptId: string; quoteHash: Hex };

export type SignedReceipt = Receipt & {
  /** hashTypedData(receipt). */
  leaf: Hex;
  /** Gateway receipt key signature over the typed data. */
  signature: Hex;
  /** Community nodes also sign outputHash. */
  nodeSignature?: Hex;
  attestation?: Attestation;
};

/** What ReceiptRoot.seal stores. */
export type Seal = { root: Hex; count: number; head: Hex };
