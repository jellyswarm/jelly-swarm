# JellySwarm

[![Backend CI](https://github.com/jellyswarm/jelly-swarm/actions/workflows/backend.yml/badge.svg)](https://github.com/jellyswarm/jelly-swarm/actions/workflows/backend.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.4.5-000000?logo=bun&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?logo=vite&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-Foundry-363636?logo=ethereum&logoColor=white)

JellySwarm lets a user give one job to as many as 247 independent AI agents. The agents work in parallel and a synthesis call returns one result. Jobs are paid upfront in USDC on Elysium and held in escrow until an operator-authorized settlement. The previous project is preserved in [`legacy/`](legacy/).

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | Vite + React job submission and results UI |
| `api/` | Vercel same-origin proxy; keeps `MASTER_API_KEY` server-side |
| `backend/` | Bun + Express + PostgreSQL API and OpenRouter agent runner |
| `contracts/` | Foundry USDC job escrow with treasury-signed EIP-712 settlements |
| `.github/workflows/backend.yml` | Backend checks, GHCR publishing, GitHub release, optional Render deployment |
| `legacy/` | Previous repository state retained under the same Git history |

## Run locally

Requirements: Bun 1.4.5, PostgreSQL, and Foundry for contract work.

```sh
cp .env.example .env
bun install
bun run dev
```

The Vite app runs on port 5173 and proxies `/api` to the backend at port 3001, adding the backend master key server-side from `backend/.env`. In another terminal:

```sh
cd backend
cp .env.example .env
bun install
bun run dev
```

The API applies SQL migrations on startup. Set `DATABASE_URL` in `backend/.env` to a local PostgreSQL database. Job quotes also require an Elysium RPC, the deployed escrow contract address, `PRICE_PER_AGENT_USDC`, `OPENROUTER_MODEL`, and the OpenRouter API key. The frontend never receives `MASTER_API_KEY`.

## Checks

```sh
# Frontend production build
bun run build

# Backend tests and typecheck
cd backend
bun test
bun run check

# Contracts
cd ../contracts
forge install --no-git foundry-rs/forge-std
forge build
forge test
```

## Backend image and deployment

The private repo's `main` workflow builds and publishes `ghcr.io/notadeveloper7/jellyswarm-backend` after tests pass, creates a GitHub release, then triggers Render if `RENDER_DEPLOY_HOOK_URL` is configured. The public repository runs backend checks but does not publish or deploy. Vercel needs `BACKEND_API_URL` and `MASTER_API_KEY` as server-side environment variables for its allowlisted `/api` proxy.

After updating private `main`, run `python3 scripts/sync-public.py` to publish its history to the public repo with the `jellyswarm` commit identity. The mirror excludes `technical-docs/`.

Configure `DATABASE_URL` and any future service secrets in the Render backend environment. The current health endpoint is `GET /health/`.

## Product/payment flow

`POST /jobs` returns a custom x402 `exact-escrow` challenge or a direct USDC quote. The user approves USDC and calls `fundJob` on the escrow, paying HYPE gas. The backend verifies the funding event and runs up to 247 agents (20 concurrent provider calls at a time) plus a synthesis call. A treasury wallet signs the EIP-712 settlement decision, selecting the client share (100%, 70%, 50%, or 0%); anyone may submit that signed decision and pays their own gas.

The escrow is not deployed yet. Configure the agreed per-model-call price and deployed contract address before accepting live jobs. Review the contract and exercise the full flow on Elysium testnet before mainnet deployment.

## License

MIT. See [`LICENSE`](LICENSE).
