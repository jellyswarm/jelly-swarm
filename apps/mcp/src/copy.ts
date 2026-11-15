/**
 * Tool names and descriptions shown to MCP clients (§9.1). A copy file:
 * scanned by the copy lint. Descriptions say "up to 247 agents", never call
 * a result advice, and never claim hardware proof outside the Sealed tier.
 */
export const SERVER = {
  name: "jellyswarm-fanout",
  title: "JellySwarm Fanout",
  version: "1.0.0",
  instructions:
    "Fan one request out over a list. Call swarm_quote first: it returns a fixed price and how many of 247 agents the job will use. Nothing runs and nothing is charged until swarm_run. Results are research data with sources, not advice.",
} as const;

export const TOOLS = {
  swarm_quote: {
    title: "Quote a swarm job",
    description:
      "Price a job before it runs. Give a task in plain words, the list of items, and the columns to fill for each item. Up to 247 agents work in parallel, one item each; longer lists run in waves. Returns a quote id, the agent count of 247, the fixed price with its lines, the tier and when the quote expires. A list containing wallet addresses is always quoted on the Sealed tier.",
  },
  swarm_run: {
    title: "Run a quoted job",
    description:
      "Start the job for a quote. Pay from a prepaid balance (pay: vault) or over x402 (pay: x402, with the paying wallet). If payment is still needed, the result lists what to pay and where instead of starting the job. The price is the quoted price; it never rises.",
  },
  swarm_status: {
    title: "Check a job",
    description:
      "Progress of a job: its state, how many rows are scouting, working, checking, passed or refunded, and what has been spent against the quote. Pass sinceSeq to get only new events.",
  },
  swarm_result: {
    title: "Get a job's result",
    description:
      'The finished table as JSON, CSV or Markdown, with a short summary and a count of unverified cells. Only rows that passed an independent check are included. A cell that could not be checked against a source reads "unverified". The table is research data, not advice.',
  },
  swarm_transcript: {
    title: "Get a job's receipts",
    description:
      "The signed receipt for every model call in a job: which agent, model and host, at what cost, with a Merkle proof against the root stored on-chain. On the Open and Standard tiers receipts are signed by the service and show what it reports ran. Only Sealed jobs also carry a hardware attestation reference.",
  },
  swarm_dispute: {
    title: "Dispute rows",
    description:
      "Challenge up to 25 rows that passed, within 24 hours of settlement. Returns the dispute fee and the call your own wallet must send to open the dispute on-chain. A reversed row is refunded.",
  },
} as const;

export const TEXT = {
  paymentNeeded: "Payment is needed before this job can start. Pay the amount below to the address shown, then call swarm_run again.",
  failed: "The request could not be completed.",
} as const;
