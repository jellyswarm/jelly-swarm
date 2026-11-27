/**
 * Reversible JSON codec for jsonb columns. Unlike a hash's canonical JSON
 * (one-way: bigint becomes a plain string), this tags bigints so a value
 * read back from the database has exactly the shape it was written with.
 */
type TaggedBigint = { $bigint: string };

const isTaggedBigint = (v: unknown): v is TaggedBigint =>
  v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>).$bigint === "string";

export function encodeJsonb(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() } satisfies TaggedBigint;
  if (Array.isArray(value)) return value.map(encodeJsonb);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = encodeJsonb(v);
    return out;
  }
  return value;
}

export function decodeJsonb<T>(value: unknown): T {
  if (isTaggedBigint(value)) return BigInt(value.$bigint) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => decodeJsonb(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeJsonb(v);
    return out as T;
  }
  return value as T;
}
