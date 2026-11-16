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
Set `DATABASE_URL` and `REDIS_URL` manually in your local `.env` file (copied from `.env.example`).
No automated CI workflow is used in this repository; all database and Redis connection URLs are configured directly by the developer.

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

## Rules that tests enforce

- Money is integer micro-dollars (`bigint`), never a float.
- At most 247 concurrent agents per job.
- Fee split is fixed at 8000 / 1000 / 500 / 500 bps.
- No email plaintext and no identity-document fields in the database.
- User-facing strings live in copy files (`copy.ts`, `*.copy.ts`, `copy/`,
  `templates/`) and pass the copy lint.
