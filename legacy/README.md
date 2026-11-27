# jelly-core

The shared engine behind Fanout, Trawl and Picket. Internal.

The source of truth for behaviour is `docs/source/core-backend.txt` (extracted
from the build doc PDF beside it). Section references such as §3.2 in code
comments point there.

## Layout

| Path | Contents |
|---|---|
| `packages/shared` | Constants from the hard rules, money helpers, chain registry, env |
| `packages/db` | Drizzle schema and migrations |
| `packages/receipts` | Signed receipt per call, per-job hash chain, Merkle root, verifier |
| `packages/budget-guard` | Atomic spend reservations against the quote and daily budgets (memory and Redis) |
| `packages/policy` | Data envelopes, registered system prompts, role tool manifests |
| `packages/gateway` | Model router: tier and host rules, health, fallback, budget, receipts |
| `packages/engine` | Job spec, wallet rule, pricebook, signed quotes, scheduler, worker loop, job engine |
| `packages/fetcher` | The one way to read the web: SSRF guard, robots.txt, page text |
| `packages/tools` | Worker's read-only tools (fetch_url, chain_read) and the chain reader |
| `packages/checker` | Row checks against sources, the judge, signed verdict and rows root |
| `packages/merger` | Result table (CSV, Markdown, JSON) and the cited summary |
| `packages/queues` | BullMQ queue names, defaults and deterministic row job ids |
| `packages/x402` | Pay-per-request over HTTP: payment requirements, EIP-3009 facilitator, replay guard |
| `packages/service` | Job lifecycle behind every interface: quote → fund → run → merge → seal → settle |
| `packages/settlement` | Audit sampling, volume classification, the settlement-keeper, `/stats` |
| `packages/live` | Live progress event schema, the in-process event bus, channel and tile-rate rules |
| `packages/auth` | Passkey, email link, anonymous device, SIWE wallet sign-in, sessions, identity merge |
| `packages/abuse` | Hashcash PoW, rate buckets, the free-tier task policy, ban escalation |
| `packages/templates` | `defineTemplate`, the versioned registry, the v1 gallery |
| `contracts` | Solidity (Foundry): escrow, row split, vault, forwarder, fees, burn, operators |
| `apps/api` | REST /v1, x402 routes, tRPC, live SSE/WebSocket, `/stats`, agent-card and x402 discovery documents |
| `apps/mcp` | The six `swarm_*` MCP tools, over stdio and streamable HTTP |
| `apps/keeper` | Runs the settlement-keeper on an interval |
| `apps/meter` | Runs the daily volume classifier |
| `apps/intake` | Chat-first intake: drafts a job spec from plain words, with a bounded generator step |
| `tools/copy-lint` | Fails the build on banned wording in user-facing strings |
| `docs/day1.md` | Facts that must be verified before launch |
| `docs/in-repo-core.md` | Pieces written here that the build doc expected to import |

`programs/` is added in a later phase.

## Run it

Needs Bun 1.4+, pnpm 10, Node 22 and Docker.

### Environment & Database Setup
Copy `.env.example` to `.env`, set `MASTER_API_KEY` to a long random value, then set `DATABASE_URL` and `REDIS_URL`. Use the same master key in the API and trusted web proxy; do not put it in browser code. The API-specific variables are listed in `apps/api/.env.example`.
GitHub Actions runs frontend, backend, and contract checks in the private deployment repository and the public mirror. The backend image publish and Render deploy hook run only from `NotADeveloper7/jellyswarm` on `main`.

```bash
pnpm install
pnpm infra:up      # Postgres on 5433, Redis on 6380
pnpm db:migrate
pnpm check         # typecheck + copy lint + tests
```

Contracts need Foundry. The libraries are not committed:

```bash
pnpm contracts:deps
pnpm contracts:build
pnpm contracts:test
```

After changing `packages/db/src/schema.ts`, run `pnpm db:generate` and commit
the new migration.

## Deployment

The Bun web server serves the static site and proxies `/api/*` to `API_URL`, adding `MASTER_API_KEY` on the server side. Deploy `apps/web` to Vercel with **Root Directory** `apps/web` and **Framework Preset** `Container`; set `API_URL` and `MASTER_API_KEY` as server environment variables for Preview and Production. Its Dockerfile is scoped to that directory, which is also the Vercel build context.

Deploy the API as a persistent container service (for example, Render), with `DATABASE_URL`, `REDIS_URL`, `MASTER_API_KEY`, `SIGNER_PRIVATE_KEY`, `OPEN_ROUTER_API_KEY` (or `MODEL_HOST_API_KEY`), and the selected chain RPC and escrow addresses. Configure the public API URL and web origin variables as well. The API rejects startup without a 32-character `MASTER_API_KEY`; `GET /health` is the sole public endpoint. Keep the web proxy and API keys identical.

GitHub Actions checks run in `NotADeveloper7/jellyswarm` and `jellyswarm/jelly-swarm`. Only pushes to `main` in the private deployment repository publish the API image and trigger `RENDER_DEPLOY_HOOK_URL` when configured. Add that secret in the private repository's Actions settings.

## Rules that tests enforce

- Money is integer micro-dollars (`bigint`), never a float.
- At most 247 concurrent agents per job.
- Fee split is fixed at 8000 / 1000 / 500 / 500 bps.
- No email plaintext and no identity-document fields in the database.
- User-facing strings live in copy files (`copy.ts`, `*.copy.ts`, `copy/`,
  `templates/`) and pass the copy lint.
