import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { COLUMNS, makeService } from "@jelly/service/src/testkit";
import type { Address } from "viem";
import type { ApiResult, SwarmApi } from "./api";
import { createMcpServer } from "./server";

const WALLET = "0x000000000000000000000000000000000000dEaD" as Address;

/** Routes the MCP tools straight to a real JobService, skipping HTTP. */
function makeTestApi(s: ReturnType<typeof makeService>): SwarmApi {
  const ok = (data: unknown): ApiResult => ({ ok: true, status: 200, data });
  const fail = (status: number, message: string, data?: unknown): ApiResult => ({ ok: false, status, message, ...(data ? { data } : {}) });
  const account = { id: "mcp-caller", tier: "paid" as const };
  return {
    quote: (input) => s.service.quote(account, input as never).then(ok, (e) => fail(400, e.message)),
    runFromVault: () => Promise.resolve(fail(400, "not used in this test")),
    runX402: async (quoteId, payer) => {
      const { job } = await s.service.prepare(account, quoteId, "wallet", payer);
      if (job.state !== "awaiting_payment") return ok(job);
      const stored = (await s.store.getJob(job.jobKey))!;
      s.escrow.markFunded(stored.jobId, payer as Address);
      return s.service.confirm(account, job.jobKey).then(ok);
    },
    status: (jobKey, sinceSeq) => s.service.status(account, jobKey as `0x${string}`, sinceSeq).then(ok, (e) => fail(404, e.message)),
    result: (jobKey, format) => s.service.result(account, jobKey as `0x${string}`, format).then(ok, (e) => fail(409, e.message)),
    transcript: (jobKey, rowIdx) => s.service.transcript(account, jobKey as `0x${string}`, rowIdx).then((d) => ok(d), (e) => fail(409, e.message)),
    dispute: (jobKey, rowIdx, evidence) =>
      s.service.dispute(account, jobKey as `0x${string}`, rowIdx, evidence).then((d) => ok(d), (e) => fail(400, e.message)),
  };
}

async function connected(api: SwarmApi) {
  const server = createMcpServer(api);
  const client = new Client({ name: "test", version: "1.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);

describe("MCP server (§9.1)", () => {
  test("lists exactly the six swarm tools", async () => {
    const s = makeService();
    const { client } = await connected(makeTestApi(s));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "swarm_dispute",
      "swarm_quote",
      "swarm_result",
      "swarm_run",
      "swarm_status",
      "swarm_transcript",
    ]);
  });

  test("tool descriptions never call a result advice or claim non-Sealed hardware proof", async () => {
    const s = makeService();
    const { client } = await connected(makeTestApi(s));
    const { tools } = await client.listTools();
    const all = tools.map((t) => t.description).join(" ");
    expect(/\badvice\b/i.test(all)).toBe(false);
    expect(all).toContain("up to 247");
  });

  test("swarm_quote then swarm_run end to end, with a source behind each cell", async () => {
    const s = makeService();
    const { client } = await connected(makeTestApi(s));

    const quoted = text(
      await client.callTool({
        name: "swarm_quote",
        arguments: { task: "holders", items: ["tok-0", "tok-1"], columns: COLUMNS },
      }),
    );
    expect(quoted).toMatchObject({ agents: 2, of: 247 });

    const run = text(await client.callTool({ name: "swarm_run", arguments: { quoteId: quoted.quoteId, pay: "x402", payer: WALLET } }));
    expect(run.job.state).toBe("running");
    await s.service.finished(run.job.jobKey);

    const status = text(await client.callTool({ name: "swarm_status", arguments: { jobKey: run.job.jobKey } }));
    expect(status.state).toBe("settled");

    const result = text(await client.callTool({ name: "swarm_result", arguments: { jobKey: run.job.jobKey, format: "json" } }));
    expect(JSON.parse(result.content).rows[0].cells.holders.sourceUrl).toStartWith("https://");

    const transcript = text(await client.callTool({ name: "swarm_transcript", arguments: { jobKey: run.job.jobKey } }));
    expect(transcript.receipts.length).toBeGreaterThan(0);
  });

  test("running without pay=x402 payer is refused with a message, not a crash", async () => {
    const s = makeService();
    const { client } = await connected(makeTestApi(s));
    const quoted = text(await client.callTool({ name: "swarm_quote", arguments: { task: "x", items: ["tok-0"], columns: COLUMNS } }));
    const result = await client.callTool({ name: "swarm_run", arguments: { quoteId: quoted.quoteId, pay: "x402" } });
    expect(result.isError).toBe(true);
  });

  test("swarm_dispute returns the on-chain call for the client's own wallet", async () => {
    const s = makeService();
    const { client } = await connected(makeTestApi(s));
    const quoted = text(await client.callTool({ name: "swarm_quote", arguments: { task: "x", items: ["tok-0", "tok-1"], columns: COLUMNS } }));
    const run = text(await client.callTool({ name: "swarm_run", arguments: { quoteId: quoted.quoteId, pay: "x402", payer: WALLET } }));
    await s.service.finished(run.job.jobKey);
    const dispute = text(await client.callTool({ name: "swarm_dispute", arguments: { jobKey: run.job.jobKey, rowIdx: [0] } }));
    expect(dispute.onchain.rowIdx).toEqual([0]);
  });

  test("a tool call with the wrong argument shape is rejected before reaching the API", async () => {
    const s = makeService();
    const { client } = await connected(makeTestApi(s));
    const result = await client.callTool({ name: "swarm_quote", arguments: { task: "x" } });
    expect(result.isError).toBe(true);
  });
});
