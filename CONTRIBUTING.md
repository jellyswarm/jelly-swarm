# Contributing

## What to work on

The current priority is to shape the new product direction and agree on the smallest useful first release. Open a discussion or issue before adding product-specific tables, payment flows, or contract behavior.

## Out of scope for the scaffold

- Reintroducing the previous implementation without an explicit design decision.
- Adding token economics, custody, or mainnet contract functionality before the product behavior is specified.
- Committing credentials, `.env` files, local wallets, or deployment artifacts.

## Setup

Install Bun 1.4.5 and PostgreSQL. Clone the repo, copy `.env.example` to `.env`, install root dependencies with `bun install`, then run `bun run dev`. For the API, copy `backend/.env.example` to `backend/.env`, install with `cd backend && bun install`, then start with `bun run dev`.

## Workflow

Create a focused branch and open a pull request against `main`. Keep each PR to one concern. Backend changes should pass `bun test` and `bun run check`; frontend changes should pass `bun run build`. Contract changes should include Foundry tests and must not introduce real asset handling without an approved design.

Use imperative, plain-English commit messages. Include what changed, why, and any migration or rollout notes in the PR. For bug reports, include what you did, what you expected, what happened, and clear reproduction steps.

Report security issues privately using the process in [`SECURITY.md`](SECURITY.md), not in a public issue.
