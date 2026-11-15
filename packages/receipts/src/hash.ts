import { type Hex, concat, keccak256, toBytes } from "viem";

/**
 * Deterministic JSON: object keys sorted, bigint as a decimal string,
 * `undefined` members dropped. The same value always yields the same bytes,
 * whatever order its keys were written in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number cannot be hashed");
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : normalise(x)));
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`;
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = normalise(x);
    }
    return out;
  }
  return v;
}

/** keccak256 of the canonical JSON of a value. */
export const hashJson = (value: unknown): Hex => keccak256(toBytes(canonicalJson(value)));

/** keccak256 of a UTF-8 label: model ids and host labels. */
export const hashLabel = (label: string): Hex => keccak256(toBytes(label));

/** §4 attestationRef for Sealed calls: keccak(x-receipt-id ‖ TDX quote hash). */
export const attestationRef = (receiptId: string, quoteHash: Hex): Hex =>
  keccak256(concat([toBytes(receiptId), quoteHash]));
