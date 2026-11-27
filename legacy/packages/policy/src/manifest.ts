import type { Role } from "@jelly/shared";
import { z } from "zod";

/**
 * Role manifests (§13). The set of tools a role may call is fixed in code.
 * The model can only pick from it; no input can extend it.
 */
export type ToolDef = {
  name: string;
  description: string;
  input: z.ZodType;
};

export type RoleManifest = { role: Role; tools: readonly ToolDef[] };

/**
 * §13: "No signing, no send, no purchase tools exist anywhere in the engine."
 * A manifest containing a tool whose name suggests moving money or acting on
 * someone's behalf cannot be defined at all.
 */
const FORBIDDEN_TOOL =
  /(^|_)(sign|send|transfer|withdraw|deposit|pay|purchase|buy|sell|book|order|swap|trade|claim|approve|post|email|message|spawn|create_agent)(_|$)/i;

export class ForbiddenToolError extends Error {
  constructor(readonly tool: string) {
    super(`tool "${tool}" is not allowed: the engine has no signing, sending, purchasing or spawning tools`);
    this.name = "ForbiddenToolError";
  }
}

export function defineManifest(role: Role, tools: readonly ToolDef[]): RoleManifest {
  const seen = new Set<string>();
  for (const t of tools) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) throw new Error(`invalid tool name: ${t.name}`);
    if (FORBIDDEN_TOOL.test(t.name)) throw new ForbiddenToolError(t.name);
    if (seen.has(t.name)) throw new Error(`duplicate tool in manifest: ${t.name}`);
    seen.add(t.name);
  }
  return Object.freeze({ role, tools: Object.freeze([...tools]) });
}

export const NO_TOOLS = (role: Role): RoleManifest => defineManifest(role, []);

/** A tool call as the model returned it: arguments are still a JSON string. */
export type RawToolCall = { id: string; name: string; arguments: string };
export type ToolCall = { id: string; name: string; input: unknown };
export type RejectedToolCall = { id: string; name: string; reason: "not_in_manifest" | "invalid_arguments" };

/**
 * Keeps only calls that name a tool in the manifest and whose arguments parse
 * against that tool's schema. Everything else is reported, never executed.
 */
export function checkToolCalls(
  manifest: RoleManifest,
  calls: readonly RawToolCall[],
): { accepted: ToolCall[]; rejected: RejectedToolCall[] } {
  const accepted: ToolCall[] = [];
  const rejected: RejectedToolCall[] = [];
  for (const call of calls) {
    const tool = manifest.tools.find((t) => t.name === call.name);
    if (!tool) {
      rejected.push({ id: call.id, name: call.name, reason: "not_in_manifest" });
      continue;
    }
    let args: unknown;
    try {
      args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
    } catch {
      rejected.push({ id: call.id, name: call.name, reason: "invalid_arguments" });
      continue;
    }
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) {
      rejected.push({ id: call.id, name: call.name, reason: "invalid_arguments" });
      continue;
    }
    accepted.push({ id: call.id, name: call.name, input: parsed.data });
  }
  return { accepted, rejected };
}

/** OpenAI-style tool definitions for the wire. */
export function wireTools(manifest: RoleManifest) {
  return manifest.tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.input) },
  }));
}
