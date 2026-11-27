import { normalizeItems } from "@jelly/engine";
import { z } from "zod";
import { type TemplateDef, defineTemplate } from "./define";

/**
 * §11.3 v1 gallery, studio-curated. A representative slice of the doc's
 * list (token DD sweep, wallet sweep, research report, price compare) —
 * the point of this phase is the registry and versioning machinery; the
 * rest of the named templates slot in the same way once there is a product
 * reason to write their exact columns.
 */
export const TOKEN_DD_SWEEP = defineTemplate({
  slug: "token-dd-sweep",
  product: "trawl",
  title: "Check up to 500 tokens",
  params: z.object({ items: z.array(z.string()).min(1).max(500) }),
  columns: [
    { name: "holders", type: "number", needsSource: true },
    { name: "liquidity locked", type: "bool", needsSource: true },
    { name: "next unlock", type: "date", needsSource: true },
  ],
  defaultTier: "standard",
  safetyClass: "crypto-readonly",
  example: { items: ["<mint>", "..."] },
  pricebookKey: "trawl.token",
  build: (p) => ({ task: "For each token, give holders, whether liquidity is locked, and the next unlock date.", items: normalizeItems(p.items).map((i) => i.raw) }),
});

export const WALLET_AIRDROP_SWEEP = defineTemplate({
  slug: "wallet-airdrop-sweep",
  product: "trawl",
  title: "Check your wallets for unclaimed airdrops",
  params: z.object({ items: z.array(z.string()).min(1).max(247) }),
  columns: [
    { name: "unclaimed airdrops", type: "text", needsSource: true },
    { name: "total value", type: "number", needsSource: true },
  ],
  defaultTier: "sealed",
  safetyClass: "private",
  example: { items: ["<wallet>"] },
  pricebookKey: "trawl.wallet",
  build: (p) => ({ task: "For each wallet, list unclaimed airdrops and their total value.", items: normalizeItems(p.items).map((i) => i.raw) }),
});

export const RESEARCH_REPORT = defineTemplate({
  slug: "research-report",
  product: "trawl",
  title: "Research report",
  params: z.object({ topic: z.string().min(1).max(500), questions: z.array(z.string().min(1).max(500)).min(1).max(20) }),
  columns: [{ name: "finding", type: "text", needsSource: true }],
  defaultTier: "standard",
  safetyClass: "public",
  example: { topic: "stablecoin market share", questions: ["Who are the top 5 issuers by market cap?"] },
  pricebookKey: "trawl.report",
  build: (p) => ({ task: `Research ${p.topic}.`, items: p.questions }),
});

export const PRICE_COMPARE = defineTemplate({
  slug: "price-compare",
  product: "trawl",
  title: "Compare prices across retailers",
  params: z.object({ product: z.string().min(1).max(300), retailers: z.array(z.string().min(1).max(100)).min(1).max(50) }),
  columns: [
    { name: "price", type: "number", needsSource: true },
    { name: "in stock", type: "bool", needsSource: true },
  ],
  defaultTier: "standard",
  safetyClass: "public",
  example: { product: "iPhone 17", retailers: ["Amazon", "Best Buy"] },
  pricebookKey: "trawl.everyday",
  build: (p) => ({ task: `Compare the price and stock of ${p.product} across these retailers.`, items: p.retailers }),
});

// Widened to TemplateDef<unknown>: a gallery holds templates with different
// param types side by side, same as a registry does once they are in it.
// `defineTemplate`'s own `build` field makes P contravariant, so this is a
// real erasure (not just a cosmetic cast) — the same one MemoryTemplateRegistry
// performs internally when it stores a template.
export const V1_GALLERY: TemplateDef<unknown>[] = [TOKEN_DD_SWEEP, WALLET_AIRDROP_SWEEP, RESEARCH_REPORT, PRICE_COMPARE].map(
  (t) => t as TemplateDef<unknown>,
);
