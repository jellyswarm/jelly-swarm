/**
 * User-facing strings for the HTTP API. A copy file: scanned by the copy lint.
 */
export const COPY = {
  unauthorized: "Send your access key as: Authorization: Bearer <key>.",
  internal: "Something went wrong on our side. Nothing was charged for this request.",
  badRequest: "The request body is not valid.",
  payerHeader: "Send the paying wallet address in the X-Jelly-Payer header.",
  topUpMinimum: "A prepaid top-up is at least $5.",
  accessKeyNote: "Keep this access key. Send it as a Bearer token to read this quote and its job. It is shown once.",
  keyNote: "Keep this key secret; it is shown once. It cannot spend until the owner wallet signs a spend grant.",
  x402Job: "Runs one JellySwarm job: up to 247 agents work through your list, and rows that fail checking are refunded.",
  x402TopUp: "Adds to a prepaid JellySwarm balance. The owner can withdraw it at any time.",
  replayed: "This payment authorization was already used. Sign a new one.",
  watchNotFound: "No watch with that id for this account.",
  noPayer: "This job has no payer address to fund from.",
  emailDevNote: "No mailer is configured: this dev build returns the link token directly instead of emailing it.",
  freeTierNotConfigured: "The free tier is not available right now.",
  freeTierBanned: "This device or account can no longer start free jobs.",
  powInvalid: "That proof-of-work answer is missing, wrong, or has expired. Ask for a new challenge.",
  freeTierRateLimited: "You've used up your free jobs for now. Try again later, or pay for this one.",
  agentName: "JellySwarm Fanout",
  agentDescription:
    "Give it a list and a question. Up to 247 open-model agents work through the list in parallel, an independent checker re-checks every row against its sources, and you pay only for rows that pass. The price is fixed before the job runs.",
  skillQuote: "Price a job before it runs: the agent count of 247 and the fixed price.",
  skillRun: "Run a priced job and return one table with a source behind every cell.",
} as const;
