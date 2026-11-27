# JellySwarm backend

Standalone Bun + Express + PostgreSQL service.

```sh
cp .env.example .env
bun install
bun run dev
```

Startup applies sorted SQL migrations transactionally. `GET /health/` is public and reports status, timestamp, application version, and `buildSha` (set with the Docker build argument `APP_COMMIT_SHA`). Every other request requires `x-api-key: $MASTER_API_KEY` and fails closed if the key is not configured. Keep this key on trusted servers; a browser frontend must not embed it.

`POST /jobs` creates a quote and returns a 402 challenge for the custom `exact-transfer` x402 flow, or a direct USDC quote. The user sends the exact USDC amount to `ESCROW_PUBLIC_KEY` and posts the transaction hash to `POST /jobs/:id/payment`. The API verifies the USDC `Transfer` event and waits for two additional blocks before starting the agents. `PRICE_PER_AGENT_USDC` is the product's charge per requested agent; the total is that price multiplied by agent count, with synthesis included. It is currently set to `0.3` USDC per agent, or `74.1` USDC for 247 agents. Jobs support 1–247 agents, with up to 20 model calls in flight at once. `OPENROUTER_MODEL` selects the model; requests are routed price-first.

On successful work, the backend transfers the USDC proceeds from the escrow wallet to `TREASURY_PUBLIC_KEY`. Failed jobs wait for an operator refund decision. The API accepts only a treasury-signed EIP-712 decision, with a 100%, 70%, or 50% client share; the remainder goes to treasury. The escrow wallet's HYPE balance pays for its payout transactions. Users pay their own HYPE gas for their USDC payment.

For an operator refund, request the typed data from `GET /jobs/:id/settlement/typed-data?clientShareBps=7000&deadline=<unix-seconds>`, have the treasury wallet sign it, then send the signature to `POST /jobs/:id/settlement`. Use `5000`, `7000`, or `10000` for 50/50, 70/30, or full client refund. The backend checks the signature against `TREASURY_PUBLIC_KEY` before moving escrow funds.

```sh
bun test
bun run check
```
