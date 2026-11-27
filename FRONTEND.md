# JellySwarm frontend handoff

This guide describes the product and the API contract for the browser UI. The Vite/React app is at the repository root (`src/`). In production it calls the same-origin Vercel proxy at `/api`; the proxy adds the backend API key on the server and forwards the request to the backend.

## Product

JellySwarm takes one task from a user and runs it with up to **247 independent AI agents in parallel**. A synthesis step combines their findings into one result. The user pays upfront in USDC on Elysium. The current price is **0.30 USDC per agent**, with synthesis included, so the total is `agentCount × 0.30 USDC` (maximum 74.10 USDC). The user signs and pays for their own transactions with HYPE for gas; JellySwarm does not sponsor user gas.

The USDC payment goes to JellySwarm's escrow EOA. After a successful job, escrow sends the proceeds to treasury. A failed job waits for an operator decision signed by the treasury wallet; the operator can choose a 100%, 70%, or 50% client share, with the remainder going to treasury. This is an operator process, not a user-facing refund control.

## API key and environments

**Ask Skipp/David for the API key and help with API or deployment problems.** Skipp and David are the same person.

Never put `MASTER_API_KEY` in React code, a `VITE_*` variable, browser storage, HTML, or a request made directly from the browser to Render. The backend requires `x-api-key` on every route except health. In production, the Vercel proxy at `api/[...path].js` reads `MASTER_API_KEY` from a server-side Vercel environment variable and adds the header to upstream requests. Use only same-origin `/api/...` URLs from the UI.

Vercel needs these server-side variables:

- `BACKEND_API_URL`: backend origin, currently `https://api.jellyswarm.app`.
- `MASTER_API_KEY`: obtain from Skipp/David; do not copy it into this document or source control.

The current proxy allowlist exposes job creation, payment verification, job reads, and agent reads. It does not expose health or settlement/admin routes. Do not broaden that allowlist or build an operator settlement UI without coordinating with Skipp/David.

## Elysium wallet details

- Chain: Elysium mainnet, chain ID `99901` (`0x1863d`).
- Native gas token: HYPE.
- USDC contract: `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` (6 decimals).
- Payment is an ERC-20 `transfer(escrowAddress, amountBaseUnits)` signed by the connected user.
- Treat the escrow address and quoted amount returned by the API as authoritative. Do not hard-code the escrow address or calculate a different amount in the UI.

## Browser request flow

Call the Vercel proxy, not the backend host directly. Include JSON content type for JSON requests. The proxy forwards the status code and body and relays the `PAYMENT-REQUIRED` response header.

### 1. Create a job and get the payment quote

`POST /api/jobs`

```json
{
  "task": "Compare the options and recommend one, with reasons.",
  "agentCount": 12,
  "clientAddress": "0x<connected-wallet-address>",
  "paymentMode": "x402"
}
```

`task` must contain 3–12,000 characters. `agentCount` must be an integer from 1 to 247. `clientAddress` must be the connected EVM wallet. `paymentMode` is `x402` or `direct` (defaults to `x402`). Both modes use the same USDC transfer and payment verification flow; the mode changes the quote response semantics.

For `x402`, **HTTP 402 is the expected quote response**, not a generic failure. The JSON body includes:

```json
{
  "error": "payment_required",
  "jobId": "0x<bytes32>",
  "agentCount": 12,
  "paymentMode": "x402",
  "payment": {
    "x402Version": 1,
    "accepts": [{
      "scheme": "exact-transfer",
      "network": "eip155:99901",
      "asset": "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65",
      "amount": "7200000",
      "payTo": "0x<escrow-address>",
      "resource": "/jobs/<job-id>"
    }]
  },
  "fundCall": {
    "contract": "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65",
    "functionName": "transfer",
    "args": ["0x<escrow-address>", "7200000"]
  },
  "gasToken": "HYPE"
}
```

The example amount is 12 agents × 0.30 USDC = 7.20 USDC = 7,200,000 base units. The API also sends a base64-encoded JSON `PAYMENT-REQUIRED` header containing the payment requirements. The JSON body is sufficient for the current UI.

For `paymentMode: "direct"`, a valid quote returns **HTTP 201** with the same `jobId`, `payment`, `fundCall`, and `gasToken` fields. It is still the user's wallet that submits the USDC transfer; "direct" does not mean the server takes custody of the user's key or submits on their behalf.

### 2. Ask the connected wallet to transfer the quoted USDC

Use the quote's `fundCall.contract`, `fundCall.args[0]` (recipient), and `fundCall.args[1]` (base-unit amount). Ask the user to confirm the transaction in their wallet. Make sure the wallet is on Elysium (`99901`) and has enough HYPE for gas. Wait for a successful receipt, then allow time for the backend's two-block confirmation requirement.

Do not treat a wallet prompt or transaction hash alone as proof of payment. The backend verifies the confirmed USDC `Transfer` event's token, sender (`clientAddress`), recipient (escrow), and exact amount.

### 3. Submit the transaction hash for verification

`POST /api/jobs/{jobId}/payment`

```json
{ "transactionHash": "0x<64-hex-transaction-hash>" }
```

On acceptance the API returns **HTTP 202**:

```json
{ "jobId": "0x<bytes32>", "status": "queued" }
```

The backend starts the agents asynchronously. If payment is not yet deep enough, retry the same request after a short delay when the API returns `409 payment_not_confirmed`. Do not ask the user to pay again. If verification is temporarily unavailable (`502`), keep the job ID and transaction hash and offer a retry.

### 4. Poll job state and show the result

`GET /api/jobs/{jobId}` returns job details. Poll about every 2–3 seconds while the job is `queued`, `running`, or `payout_pending`. Stop polling on terminal states and provide a manual refresh/retry path for network errors.

Relevant fields include:

```json
{
  "id": "0x<bytes32>",
  "clientAddress": "0x<address>",
  "agentCount": 12,
  "amountBaseUnits": "7200000",
  "status": "running",
  "paymentTransactionHash": "0x<hash>",
  "result": null,
  "errorCode": null,
  "createdAt": "<timestamp>",
  "updatedAt": "<timestamp>"
}
```

Status values used by the backend:

- `payment_pending`: quote created; waiting for verified payment.
- `queued`: payment accepted; agent work is waiting to run.
- `running`: agents and synthesis are working.
- `payout_pending`: work succeeded; automatic treasury payout is retrying or awaiting confirmation.
- `settled`: payout completed.
- `failed`: agent work failed; an operator must decide the refund split.
- `settlement_pending`: an operator-signed refund decision is being paid out.

When successful, `result.answer` is the synthesized answer and `result.agentFindings` contains individual findings. Show the answer prominently and offer agent findings as secondary detail. Do not display a successful result as fully settled until the job status is `settled`.

`GET /api/jobs/{jobId}/agents` returns:

```json
{
  "agents": [
    { "agentNumber": 1, "status": "completed", "output": "...", "errorCode": null }
  ]
}
```

Use this for per-agent progress/details. The current endpoint returns an empty array for an unknown but well-formed job ID, so use the main job endpoint to establish whether a job exists.

## Errors and UI behavior

- `400`: invalid task, agent count, wallet address, payment mode, job ID, transaction hash, or settlement input. Explain the correction inline.
- `401`: missing/invalid service key. This indicates a proxy/configuration issue; never ask the end user for the service key. Contact Skipp/David.
- `402` from `POST /jobs`: normal x402 quote response; continue to payment confirmation.
- `404`: job ID not found. Check the ID and offer to retry lookup.
- `409`: state conflict, unconfirmed payment, or job not ready. Use the error code and current job state; do not submit a second payment blindly.
- `502` / `503`: chain, payment configuration, provider, or backend is unavailable. Preserve the job ID and transaction hash, show retry guidance, and contact Skipp/David if persistent.

Never log or display `MASTER_API_KEY`. It must only exist in Vercel's server-side environment and the backend's deployment environment.

## Out of scope for the public UI

The backend also has treasury-signed settlement endpoints (`GET /jobs/{id}/settlement/typed-data` and `POST /jobs/{id}/settlement`), but the Vercel proxy intentionally does not expose them. They are operator-only refund controls and must not be called from the public browser UI. Route changes, API contract questions, and deployment problems should go to **Skipp/David**.
