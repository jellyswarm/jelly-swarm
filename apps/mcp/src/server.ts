import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiResult, SwarmApi } from "./api";
import { SERVER, TEXT, TOOLS } from "./copy";

const JobKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Column = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(["text", "number", "bool", "url", "date"]),
  needsSource: z.boolean(),
});

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Every tool returns the API's JSON as text. A 402 is a normal answer here: it tells the caller what to pay. */
function reply(r: ApiResult): ToolResult {
  if (r.ok) return { content: [{ type: "text", text: JSON.stringify(r.data) }] };
  if (r.status === 402) {
    return { content: [{ type: "text", text: JSON.stringify({ paymentRequired: true, message: TEXT.paymentNeeded, details: r.data }) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify({ error: r.message || TEXT.failed }) }], isError: true };
}

/** §9.1 The six swarm tools. */
export function createMcpServer(api: SwarmApi): McpServer {
  const server = new McpServer({ name: SERVER.name, title: SERVER.title, version: SERVER.version }, { instructions: SERVER.instructions });

  server.registerTool(
    "swarm_quote",
    {
      ...TOOLS.swarm_quote,
      inputSchema: {
        task: z.string().min(1).max(4000),
        items: z.array(z.string().max(2000)).min(1).max(2000),
        columns: z.array(Column).min(1).max(32),
        tier: z.enum(["open", "standard", "sealed"]).optional(),
        maxAgents: z.number().int().min(1).max(247).optional(),
        templateId: z.string().max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => reply(await api.quote(args)),
  );

  server.registerTool(
    "swarm_run",
    {
      ...TOOLS.swarm_run,
      inputSchema: {
        quoteId: z.string().uuid(),
        pay: z.enum(["vault", "x402"]),
        /** x402 only: the wallet that pays and receives any refund. */
        payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ quoteId, pay, payer }) => {
      if (pay === "vault") return reply(await api.runFromVault(quoteId));
      if (!payer) return reply({ ok: false, status: 400, message: "Give the paying wallet address as `payer`." });
      return reply(await api.runX402(quoteId, payer));
    },
  );

  server.registerTool(
    "swarm_status",
    {
      ...TOOLS.swarm_status,
      inputSchema: { jobKey: JobKey, sinceSeq: z.number().int().nonnegative().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ jobKey, sinceSeq }) => reply(await api.status(jobKey, sinceSeq)),
  );

  server.registerTool(
    "swarm_result",
    {
      ...TOOLS.swarm_result,
      inputSchema: { jobKey: JobKey, format: z.enum(["json", "csv", "md"]).default("json") },
      annotations: { readOnlyHint: true },
    },
    async ({ jobKey, format }) => reply(await api.result(jobKey, format)),
  );

  server.registerTool(
    "swarm_transcript",
    {
      ...TOOLS.swarm_transcript,
      inputSchema: { jobKey: JobKey, rowIdx: z.number().int().nonnegative().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ jobKey, rowIdx }) => reply(await api.transcript(jobKey, rowIdx)),
  );

  server.registerTool(
    "swarm_dispute",
    {
      ...TOOLS.swarm_dispute,
      inputSchema: {
        jobKey: JobKey,
        rowIdx: z.array(z.number().int().nonnegative()).min(1).max(25),
        evidence: z.string().max(4000).default(""),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ jobKey, rowIdx, evidence }) => reply(await api.dispute(jobKey, rowIdx, evidence)),
  );

  return server;
}
