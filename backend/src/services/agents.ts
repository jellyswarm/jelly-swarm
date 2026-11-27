import { pool } from "../db";
import { executeSuccessPayout } from "./settlements";

type AgentRecord = { agent_number: number };

async function runAgent(task: string, agentNumber: number, total: number): Promise<string> {
  const apiKey = process.env.OPEN_ROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) throw new Error("agent_provider_not_configured");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://jellyswarm.com",
      "X-Title": "JellySwarm",
    },
    body: JSON.stringify({
      model,
      provider: { sort: "price" },
      messages: [
        {
          role: "system",
          content: `You are independent research worker ${agentNumber} of ${total}. Make a distinct, useful contribution to the user's job. State assumptions and uncertainty. Do not claim to have used tools or sources you did not use.`,
        },
        { role: "user", content: task },
      ],
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) throw new Error(`agent_provider_http_${response.status}`);
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const output = body.choices?.[0]?.message?.content?.trim();
  if (!output) throw new Error("agent_empty_output");
  return output;
}

async function synthesize(task: string, outputs: string[]): Promise<string> {
  const apiKey = process.env.OPEN_ROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) throw new Error("agent_provider_not_configured");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://jellyswarm.com",
      "X-Title": "JellySwarm",
    },
    body: JSON.stringify({
      model,
      provider: { sort: "price" },
      messages: [
        { role: "system", content: "Synthesize the submitted independent work into a clear answer. Preserve useful disagreements and uncertainty. Do not add unsupported claims." },
        { role: "user", content: JSON.stringify({ task, agentFindings: outputs.map((output) => output.slice(0, 1_000)) }) },
      ],
      max_tokens: 2_000,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) throw new Error(`synthesis_provider_http_${response.status}`);
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const output = body.choices?.[0]?.message?.content?.trim();
  if (!output) throw new Error("synthesis_empty_output");
  return output;
}

export async function runJobAgents(jobId: string, task: string, agentCount: number): Promise<void> {
  const claimed = await pool.query(
    "UPDATE swarm_jobs SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING id",
    [jobId],
  );
  if (!claimed.rowCount) return;
  await pool.query(
    `INSERT INTO swarm_job_agents (job_id, agent_number, status)
     SELECT $1, n, 'queued' FROM generate_series(1, $2::int) AS n
     ON CONFLICT (job_id, agent_number) DO NOTHING`,
    [jobId, agentCount],
  );

  const results = new Array<string>(agentCount);
  let next = 0;
  const workers = Array.from({ length: Math.min(20, agentCount) }, async () => {
    while (true) {
      const index = next++;
      if (index >= agentCount) return;
      const agentNumber = index + 1;
      await pool.query(
        "UPDATE swarm_job_agents SET status = 'running', updated_at = now() WHERE job_id = $1 AND agent_number = $2",
        [jobId, agentNumber],
      );
      try {
        const output = await runAgent(task, agentNumber, agentCount);
        results[index] = output;
        await pool.query(
          "UPDATE swarm_job_agents SET status = 'completed', output = $3, updated_at = now() WHERE job_id = $1 AND agent_number = $2",
          [jobId, agentNumber, output],
        );
      } catch (error) {
        await pool.query(
          "UPDATE swarm_job_agents SET status = 'failed', error_code = $3, updated_at = now() WHERE job_id = $1 AND agent_number = $2",
          [jobId, agentNumber, error instanceof Error ? error.message.slice(0, 100) : "agent_failed"],
        );
      }
    }
  });
  await Promise.all(workers);

  const rows = await pool.query<AgentRecord>(
    "SELECT agent_number FROM swarm_job_agents WHERE job_id = $1 AND status = 'failed' ORDER BY agent_number",
    [jobId],
  );
  if (rows.rowCount) {
    await pool.query("UPDATE swarm_jobs SET status = 'failed', error_code = 'agent_failed', updated_at = now() WHERE id = $1", [jobId]);
    return;
  }

  let result: string;
  try {
    result = await synthesize(task, results);
  } catch {
    await pool.query("UPDATE swarm_jobs SET status = 'failed', error_code = 'synthesis_failed', updated_at = now() WHERE id = $1", [jobId]);
    return;
  }
  await pool.query(
    "UPDATE swarm_jobs SET status = 'payout_pending', result = $2::jsonb, updated_at = now() WHERE id = $1",
    [jobId, JSON.stringify({ answer: result, agentCount, agentFindings: results })],
  );
  await executeSuccessPayout(jobId).catch(() => console.error(`Successful payout remains pending for job ${jobId}.`));
}
