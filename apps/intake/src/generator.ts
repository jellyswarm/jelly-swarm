import type { ToolExecutor } from "@jelly/engine";
import type { Gateway, JobContext } from "@jelly/gateway";
import { type Message, type RoleManifest, defineManifest, envelope } from "@jelly/policy";
import { AGENT_ID } from "@jelly/receipts";
import { z } from "zod";
import { GENERATOR_PROMPT } from "./prompt";

/**
 * §11.1 "If an item list is missing ... it emits a generator step instead:
 * the planner discovers up to N candidate items through public fetch
 * tools." A bounded, read-only search: fetch_url only, no chain reads, no
 * item list can come from anywhere but a page the model actually fetched.
 *
 * This is a first version. A thorough multi-query discovery engine (follow
 * search results, cross-check candidates across sources) is a bigger
 * feature than one gateway call with a tool loop; that stays a gap, noted
 * in docs/day1.md, until there is a product reason to invest in it.
 */
const GENERATOR_MANIFEST: RoleManifest = defineManifest("planner", [
  { name: "fetch_url", description: "Fetch one public web page and return its visible text.", input: z.object({ url: z.string().url().max(2000) }) },
]);

const GeneratorAnswer = z.object({ items: z.array(z.string().min(1).max(2000)).max(500) });

export type GeneratorDeps = { gateway: Gateway; tools: ToolExecutor };

export type GeneratorCaps = { maxToolCalls: number; maxTurns: number; maxOutputTokens: number };
export const DEFAULT_GENERATOR_CAPS: GeneratorCaps = { maxToolCalls: 8, maxTurns: 4, maxOutputTokens: 1500 };

export type GeneratorResult = { items: string[]; toolCalls: number; turns: number };

/** Discovers up to `maxItems` candidate items for a task that named none. */
export async function generateItems(
  deps: GeneratorDeps,
  job: JobContext,
  task: string,
  maxItems: number,
  caps: GeneratorCaps = DEFAULT_GENERATOR_CAPS,
): Promise<GeneratorResult> {
  const messages: Message[] = [{ role: "data", envelopes: [envelope("user", "generator-task.v1", { task, maxItems })] }];
  let toolCalls = 0;
  let turns = 0;

  while (turns < caps.maxTurns) {
    const result = await deps.gateway.call({
      job,
      role: "planner",
      agentId: AGENT_ID.planner,
      system: GENERATOR_PROMPT,
      manifest: GENERATOR_MANIFEST,
      messages,
      maxOutputTokens: caps.maxOutputTokens,
    });
    turns++;

    if (result.toolCalls.length === 0) {
      const parsed = parseAnswer(result.content);
      return { items: parsed.slice(0, maxItems), toolCalls, turns };
    }

    messages.push({ role: "assistant", content: result.content, toolCalls: result.rawToolCalls });
    for (const call of result.toolCalls) {
      if (toolCalls >= caps.maxToolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, envelope: envelope("engine", "tool-note.v1", { note: "tool call limit reached" }) });
        continue;
      }
      toolCalls++;
      try {
        const output = await deps.tools.run(call, { jobKey: job.jobKey, rowIdx: -1 });
        messages.push({ role: "tool", toolCallId: call.id, envelope: output.envelope });
      } catch {
        messages.push({ role: "tool", toolCallId: call.id, envelope: envelope("engine", "tool-note.v1", { note: "tool failed" }) });
      }
    }
  }
  return { items: [], toolCalls, turns };
}

function parseAnswer(content: string): string[] {
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = GeneratorAnswer.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.items : [];
  } catch {
    return [];
  }
}
