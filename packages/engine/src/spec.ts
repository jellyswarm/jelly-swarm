import { hashJson } from "@jelly/receipts";
import { ChainKey, Lane, MAX_AGENTS, Product, Tier } from "@jelly/shared";
import type { Hex } from "viem";
import { z } from "zod";

/** §3.1 Spec DSL. */

/** Hard ceiling on items in one job. Items beyond 247 run in waves. */
export const MAX_ITEMS = 2000;

export const ItemKind = z.enum(["evm_address", "solana_address", "url", "text"]);
export type ItemKind = z.infer<typeof ItemKind>;

export const Item = z.object({
  /** The item exactly as normalised from input. Stored and sent as data. */
  raw: z.string().min(1).max(2000),
  kind: ItemKind,
  /** Chain the address belongs to, when known. */
  chain: ChainKey.optional(),
});
export type Item = z.infer<typeof Item>;

export const ColumnType = z.enum(["text", "number", "bool", "url", "date"]);
export type ColumnType = z.infer<typeof ColumnType>;

export const Column = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/),
  type: ColumnType,
  /** A cell in this column must cite a source, or it is shown as "unverified". */
  needsSource: z.boolean(),
  /**
   * How far a number may sit from its source, in bps. Default 50 (0.5%).
   * Raise it for values that move between reads, such as holder share or liquidity.
   */
  toleranceBps: z.number().int().min(0).max(2000).optional(),
});
export type Column = z.infer<typeof Column>;

export const JobSpec = z
  .object({
    product: Product,
    templateId: z.string().optional(),
    /** The template's current version at quote time (§11.3 "the change is shown on the quote"), if templateId was consulted against a registry. */
    templateVersion: z.number().int().positive().optional(),
    /** Plain words from the user. Stored as data; never part of a system prompt. */
    task: z.string().min(1).max(4000),
    items: z.array(Item).min(1).max(MAX_ITEMS),
    columns: z.array(Column).min(1).max(32),
    /** Forced to "sealed" if any item is a wallet address. */
    tier: Tier,
    maxAgents: z.number().int().min(1).max(MAX_AGENTS),
    premiumPlanner: z.boolean().optional(),
    lane: Lane.optional(),
  })
  .superRefine((s, ctx) => {
    const names = new Set<string>();
    for (const c of s.columns) {
      const key = c.name.toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: "custom", message: `duplicate column: ${c.name}` });
      names.add(key);
    }
  });
export type JobSpec = z.infer<typeof JobSpec>;

/** §3.1 A result cell. `quoteSpan` is the passage in the source that supports the value (§3.4). */
export const ChainRead = z.object({
  chain: ChainKey,
  address: z.string().min(1),
  /** Contract function or Solana account field that was read. */
  method: z.string().min(1),
  args: z.array(z.unknown()).default([]),
  /** Divide an integer result by 10^decimals before comparing, e.g. 18 for a token balance. */
  decimals: z.number().int().min(0).max(36).optional(),
});
export type ChainRead = z.infer<typeof ChainRead>;

export const CellSource = z.object({
  url: z.string().url().optional(),
  quoteSpan: z.string().max(2000).optional(),
  chainRead: ChainRead.optional(),
});
export type CellSource = z.infer<typeof CellSource>;

export type Cell = { value: unknown | "unverified"; source: CellSource };
export type Cells = Record<string, Cell>;

export const UNVERIFIED = "unverified";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function classifyItem(raw: string, chain?: ChainKey): Item {
  const text = raw.trim();
  const base = chain ? { chain } : {};
  if (EVM_ADDRESS.test(text)) return { raw: text.toLowerCase(), kind: "evm_address", ...base };
  if (SOLANA_ADDRESS.test(text)) return { raw: text, kind: "solana_address", chain: "solana" };
  if (/^https?:\/\/\S+$/i.test(text)) return { raw: text, kind: "url" };
  return { raw: text, kind: "text" };
}

/** Trims, drops blanks and duplicates (keeping first-seen order), and classifies each item. */
export function normalizeItems(raws: readonly string[], chain?: ChainKey): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const raw of raws) {
    if (raw.trim() === "") continue;
    const item = classifyItem(raw, chain);
    const key = `${item.kind}:${item.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Stable hash of a spec; signed into the quote. */
export const specHash = (spec: JobSpec): Hex => hashJson(JobSpec.parse(spec));
