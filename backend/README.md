# JellySwarm backend

Standalone Bun + Express + PostgreSQL service.

```sh
cp .env.example .env
bun install
bun run dev
```

Startup applies sorted SQL migrations transactionally. `GET /health/` is public and reports status, timestamp, application version, and `buildSha` (set with the Docker build argument `APP_COMMIT_SHA`). Every other request requires `x-api-key: $MASTER_API_KEY` and fails closed if the key is not configured. Keep this key on trusted servers; a browser frontend must not embed it.

`POST /jobs` creates a job quote and returns a 402 payment challenge for the custom `exact-escrow` flow. The client approves the exact USDC amount, calls `fundJob` on the configured escrow contract, and posts the transaction hash to `POST /jobs/:id/payment`. The API checks the emitted `JobFunded` event and waits for two additional blocks before starting agent work. The quote uses `PRICE_PER_AGENT_USDC` per model call for each agent plus one synthesis call. Jobs with 1–247 agents are supported, with up to 20 model calls in flight per job. Configure `OPENROUTER_MODEL` explicitly so the quoted rate maps to a known model. `ESCROW_CONTRACT_ADDRESS` must be set after deployment.

Refund and success settlement decisions are signed by the treasury wallet using EIP-712 and recorded with `POST /jobs/:id/settlement`. That route returns the `settleJob` call for a client or operator to submit; the caller pays HYPE gas. Supported client shares are 100%, 70%, 50%, and 0% (full treasury settlement). Confirm the transaction with `POST /jobs/:id/settlement/confirm`.

```sh
bun test
bun run check
```
