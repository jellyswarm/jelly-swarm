# JellySwarm

[![Backend CI](https://github.com/jellyswarm/jelly-swarm/actions/workflows/backend.yml/badge.svg)](https://github.com/jellyswarm/jelly-swarm/actions/workflows/backend.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.4.5-000000?logo=bun&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?logo=vite&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-Foundry-363636?logo=ethereum&logoColor=white)

JellySwarm is being rebuilt from a clean scaffold. The previous project, including its code, docs, and assets, is preserved in [`legacy/`](legacy/). The product direction and new domain model are intentionally not carried forward as implementation requirements.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | Root Vite + React frontend |
| `backend/` | Standalone Bun + Express + PostgreSQL API |
| `contracts/` | Foundry scaffold; no product contract behavior defined yet |
| `.github/workflows/backend.yml` | Backend checks, GHCR publishing, GitHub release, optional Render deployment |
| `legacy/` | Previous repository state retained under the same Git history |

## Run locally

Requirements: Bun 1.4.5, PostgreSQL, and Foundry for contract work.

```sh
cp .env.example .env
bun install
bun run dev
```

The Vite app runs on port 5173 and proxies `/api` to the backend at port 3001. In another terminal:

```sh
cd backend
cp .env.example .env
bun install
bun run dev
```

The API applies SQL migrations on startup. Set `DATABASE_URL` in `backend/.env` to a local PostgreSQL database.

## Checks

```sh
# Frontend production build
bun run build

# Backend tests and typecheck
cd backend
bun test
bun run check

# Contract scaffold
cd ../contracts
forge install --no-git foundry-rs/forge-std
forge build
forge test
```

## Backend image and deployment

The private repo's `main` workflow builds and publishes `ghcr.io/notadeveloper7/jellyswarm-backend` after tests pass, creates a GitHub release, then triggers Render if `RENDER_DEPLOY_HOOK_URL` is configured. The public repository runs backend checks but does not publish or deploy.

After updating private `main`, run `python3 scripts/sync-public.py` to publish its history to the public repo with the `jellyswarm` commit identity. The mirror excludes `technical-docs/`.

Configure `DATABASE_URL` and any future service secrets in the Render backend environment. The current health endpoint is `GET /health/`.

## Current scope

This is infrastructure scaffolding only: a Vite landing page, a health endpoint with a migration runner, and a minimal compile/test/deploy contract placeholder. No research jobs, payment flow, user accounts, or token behavior have been implemented in the new project.

## License

MIT. See [`LICENSE`](LICENSE).
