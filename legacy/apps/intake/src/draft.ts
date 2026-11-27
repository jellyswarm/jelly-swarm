import { Column } from "@jelly/engine";
import type { JobContext } from "@jelly/gateway";
import { NO_TOOLS, envelope } from "@jelly/policy";
import { AGENT_ID } from "@jelly/receipts";
import { Product, Tier } from "@jelly/shared";
import { z } from "zod";
import { COPY } from "./copy";
import { type GeneratorDeps, generateItems } from "./generator";
import { INTAKE_PROMPT } from "./prompt";

/** Loosely matches `@jelly/abuse`'s outreach pattern; duplicated as one line rather than taking a dependency on the free-tier package for one regex. */
const OUTREACH = /\b(cold\s*email|outreach|mail\s*merge|send\s+(an?\s+)?(email|message|dm)s?\s+to|blast|spam\s+list|contact\s+list|lead\s*gen)\b/i;

const Clarification = z.object({ question: z.string().min(1).max(300), choices: z.array(z.string().min(1).max(100)).max(6) });
const IntakeAnswer = z.object({
  product: Product,
  items: z.array(z.string().min(1).max(2000)).max(2000).default([]),
  needsGenerator: z.boolean().default(false),
  columns: z.array(Column).min(1).max(32),
  tier: Tier,
  clarification: Clarification.nullish(),
});

export type DraftedSpec = { product: z.infer<typeof Product>; items: string[]; columns: z.infer<typeof Column>[]; tier: z.infer<typeof Tier> };

export type DraftOutcome =
  | { status: "ok"; spec: DraftedSpec }
  | { status: "clarify"; clarification: z.infer<typeof Clarification> }
  | { status: "refused"; reason: "outreach"; message: string }
  | { status: "error"; message: string };

export type IntakeDeps = GeneratorDeps & { maxGeneratedItems?: number };

/**
 * §11.1 chat-first intake: free text (and, in a future phase, an attached
 * CSV or address list — not yet wired here) in, a drafted job spec or one
 * clarifying question out. The task text never becomes part of a system
 * prompt; it travels as data, same as everywhere else in the engine.
 */
export async function draftSpec(deps: IntakeDeps, job: JobContext, task: string): Promise<DraftOutcome> {
  if (OUTREACH.test(task)) return { status: "refused", reason: "outreach", message: COPY.outreachRefused };

  let answer: z.infer<typeof IntakeAnswer>;
  try {
    const result = await deps.gateway.call({
      job,
      role: "intake",
      agentId: AGENT_ID.intake,
      system: INTAKE_PROMPT,
      manifest: NO_TOOLS("intake"),
      maxOutputTokens: 1500,
      messages: [{ role: "data", envelopes: [envelope("user", "intake-task.v1", { task })] }],
    });
    const parsed = IntakeAnswer.safeParse(parseJson(result.content));
    if (!parsed.success) return { status: "error", message: COPY.couldNotUnderstand };
    answer = parsed.data;
  } catch {
    return { status: "error", message: COPY.couldNotUnderstand };
  }

  if (answer.clarification) return { status: "clarify", clarification: answer.clarification };
  if (OUTREACH.test(answer.columns.map((c) => c.name).join(" "))) {
    return { status: "refused", reason: "outreach", message: COPY.outreachRefused };
  }

  let items = answer.items;
  if (answer.needsGenerator || items.length === 0) {
    const generated = await generateItems(deps, job, task, deps.maxGeneratedItems ?? 50);
    items = generated.items;
    if (items.length === 0) return { status: "error", message: COPY.noItemsFound };
  }

  return { status: "ok", spec: { product: answer.product, items, columns: answer.columns, tier: answer.tier } };
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return undefined;
  }
}
