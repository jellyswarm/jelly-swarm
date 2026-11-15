import { type SignedReceipt, ZERO32, merkleProof, merkleRoot, sealOf } from "@jelly/receipts";
import { type Address, type Hex, concat, encodeAbiParameters, keccak256, verifyTypedData } from "viem";

/**
 * §3.3 step 7 and §4 "Rows root". After a job is checked, the checker key
 * signs a verdict that the settlement contract acts on:
 * Verdict{jobKey, rowCount, passedCount, rowsRoot, receiptsRoot, toolsUsd6}.
 */
export type Verdict = {
  jobKey: Hex;
  rowCount: number;
  passedCount: number;
  rowsRoot: Hex;
  receiptsRoot: Hex;
  toolsUsd6: bigint;
};

export const VERDICT_TYPES = {
  Verdict: [
    { name: "jobKey", type: "bytes32" },
    { name: "rowCount", type: "uint32" },
    { name: "passedCount", type: "uint32" },
    { name: "rowsRoot", type: "bytes32" },
    { name: "receiptsRoot", type: "bytes32" },
    { name: "toolsUsd6", type: "uint64" },
  ],
} as const;

/** The verdict is bound to one RowSplit contract on one chain. */
export type VerdictDomainParams = { chainId: number; verifyingContract: Address };
export const verdictDomain = (p: VerdictDomainParams) => ({ name: "JellySwarm RowSplit", version: "1", ...p }) as const;

export interface VerdictSigner {
  address: Address;
  signTypedData(args: {
    domain: ReturnType<typeof verdictDomain>;
    types: typeof VERDICT_TYPES;
    primaryType: "Verdict";
    message: Verdict;
  }): Promise<Hex>;
}

export type RowLeaf = {
  rowIdx: number;
  passed: boolean;
  /** The operator credited for the row if it passed. */
  operatorId: bigint;
  unitUsd6: bigint;
  /** Hash over the row's receipt leaves, in step order. */
  rowReceiptsHash: Hex;
};

/** leaf = keccak(jobKey, rowIdx, passed, operatorId, unitUsd6, rowReceiptsHash), ABI-encoded. */
export const rowLeaf = (jobKey: Hex, r: RowLeaf): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }],
      [jobKey, r.rowIdx, r.passed, r.operatorId, r.unitUsd6, r.rowReceiptsHash],
    ),
  );

/** Hash of every receipt leaf that belongs to a row; ZERO32 if the row made no calls. */
export function rowReceiptsHash(receipts: readonly SignedReceipt[], rowIdx: number): Hex {
  const leaves = receipts.filter((r) => r.rowIdx === rowIdx).map((r) => r.leaf);
  return leaves.length === 0 ? ZERO32 : keccak256(concat(leaves));
}

export type VerdictRow = { rowIdx: number; passed: boolean; operatorId: bigint };

export type BuiltVerdict = {
  verdict: Verdict;
  leaves: Hex[];
  rows: RowLeaf[];
  /** Merkle proof for one row, for a per-row dispute. */
  proofFor(rowIdx: number): Hex[];
};

/** Assembles the verdict from the engine's row results and the job's sealed receipts. */
export function buildVerdict(args: {
  jobKey: Hex;
  rows: readonly VerdictRow[];
  receipts: readonly SignedReceipt[];
  unitUsd6: bigint;
  toolsUsd6: bigint;
}): BuiltVerdict {
  const sorted = [...args.rows].sort((a, b) => a.rowIdx - b.rowIdx);
  sorted.forEach((r, i) => {
    if (r.rowIdx !== i) throw new Error(`verdict rows must cover 0..n-1 exactly once; got ${r.rowIdx} at position ${i}`);
  });
  const rows: RowLeaf[] = sorted.map((r) => ({
    ...r,
    unitUsd6: args.unitUsd6,
    rowReceiptsHash: rowReceiptsHash(args.receipts, r.rowIdx),
  }));
  const leaves = rows.map((r) => rowLeaf(args.jobKey, r));
  return {
    verdict: {
      jobKey: args.jobKey,
      rowCount: rows.length,
      passedCount: rows.filter((r) => r.passed).length,
      rowsRoot: merkleRoot(leaves),
      receiptsRoot: sealOf(args.receipts).root,
      toolsUsd6: args.toolsUsd6,
    },
    leaves,
    rows,
    proofFor: (rowIdx) => merkleProof(leaves, rowIdx),
  };
}

export const signVerdict = (signer: VerdictSigner, domain: VerdictDomainParams, verdict: Verdict): Promise<Hex> =>
  signer.signTypedData({ domain: verdictDomain(domain), types: VERDICT_TYPES, primaryType: "Verdict", message: verdict });

export const verifyVerdict = (domain: VerdictDomainParams, verdict: Verdict, signature: Hex, checker: Address): Promise<boolean> =>
  verifyTypedData({
    address: checker,
    domain: verdictDomain(domain),
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message: verdict,
    signature,
  }).catch(() => false);
