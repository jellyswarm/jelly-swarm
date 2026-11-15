import { z } from "zod";

/**
 * §0.6 and §13: untrusted input stays data.
 *
 * Anything that did not come from our own code — user chat, fetched pages,
 * another agent's output, tool results — travels in a typed envelope and is
 * rendered into a user-role data block. It is never part of a system prompt,
 * and nothing inside it can add or name a tool.
 */
export const Envelope = z.object({
  /** Where the data came from, e.g. "user", "fetch", "worker:17", "tool:fetch_url". */
  from: z.string().min(1),
  kind: z.literal("data"),
  /** Name of the payload's shape, e.g. "task.v1", "page.v1", "row.v1". */
  schema: z.string().min(1),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof Envelope>;

export const envelope = (from: string, schema: string, payload: unknown): Envelope => ({
  from,
  kind: "data",
  schema,
  payload,
});

const OPEN = "<data-block>";
const CLOSE = "</data-block>";

/**
 * Renders envelopes as one JSON data block. The payload is JSON-encoded, and
 * any `<` is escaped, so text inside it cannot close the block early or
 * imitate another one.
 */
export function renderDataBlock(envelopes: readonly Envelope[]): string {
  const json = JSON.stringify(
    envelopes.map((e) => Envelope.parse(e)),
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  ).replaceAll("<", "\\u003c");
  return `${OPEN}\n${json}\n${CLOSE}`;
}

// ───────────────────────────── system prompts ─────────────────────────────

declare const trusted: unique symbol;
/** A system prompt that was registered by our own code at module load. */
export type TrustedPrompt = string & { readonly [trusted]: true };

const registry = new Map<string, string>();
const texts = new Set<string>();

export class UntrustedPromptError extends Error {
  constructor() {
    super("system prompt is not a registered prompt; untrusted text must travel as a data envelope");
    this.name = "UntrustedPromptError";
  }
}

/**
 * Registers a fixed system prompt. Call it at module top level with a string
 * literal. A prompt built at runtime (for example by concatenating user text)
 * will not match any registered prompt, and the gateway refuses it.
 */
export function definePrompt(id: string, text: string): TrustedPrompt {
  const existing = registry.get(id);
  if (existing !== undefined && existing !== text) throw new Error(`prompt id registered twice with different text: ${id}`);
  registry.set(id, text);
  texts.add(text);
  return text as TrustedPrompt;
}

export const isTrustedPrompt = (text: string): text is TrustedPrompt => texts.has(text);

export function assertTrustedPrompt(text: string): asserts text is TrustedPrompt {
  if (!isTrustedPrompt(text)) throw new UntrustedPromptError();
}
