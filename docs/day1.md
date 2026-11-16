# Day-1 checks

Facts the build doc (§14) says must be verified before launch. Until a row is
marked confirmed, the matching value in code stays behind a flag or
`requireConfirmed`, so nothing moves money on an unverified assumption.

Status: `open` = not checked yet, `confirmed` = checked (add the evidence),
`n/a` = no longer applies.

## Infrastructure

| # | Check | Status | Result |
|---|---|---|---|
| 1 | Muster contract and test state; `ReceiptLog` domain name; `muster_split.mark_funded` | n/a | Muster is not available. Its pieces are written in this repo (see `in-repo-core.md`). |
| 2 | USDG on chain 4663: address, decimals, EIP-3009 / 2612 support; chain id 4663 itself | open | `CHAINS.rhc.confirmed = false` |
| 3 | Live ACP v2 ABI on RHC | open | |
| 4 | PayAI on Base and Solana (keyless, `payTo` to arbitrary address / ATA) | open | |
| 5 | Elysium mainnet: chain id, stablecoins, HyperEVM x402 path | open | `CHAINS.elysium` / `CHAINS.hyperevm` unconfirmed |

## Models and providers

| # | Check | Status | Result |
|---|---|---|---|
| 6 | Model LICENSE files: Kimi K3, GLM-5.3, K2.6 attribution, Qwen, gpt-oss, DeepSeek | open | |
| 7 | Inference-provider resale and KYC terms: DeepInfra, Together, Fireworks, Groq, Cerebras | open | These providers stay disabled until checked. |
| 8 | Phala live catalog and prices, `x-receipt-id` format, TDX quote verification library | open | |

## Capacity and determinism

| # | Check | Status | Result |
|---|---|---|---|
| 9 | Router load test: 250-call burst through the internal routers and batch windows | open | |
| 10 | vLLM determinism at temperature 0 on H100 for gpt-oss-120b; calibrate fingerprint thresholds | open | |

## Wallets and payments

| # | Check | Status | Result |
|---|---|---|---|
| 11 | P-256 precompile on Base and RHC; Solana secp256r1 verify; pick the audited 4337 account and paymaster | open | |
| 12 | Bridge and DEX routes for burn buckets | open | Until chosen, buckets accrue and `/stats` discloses the gap. |

## Retail

| # | Check | Status | Result |
|---|---|---|---|
| 13 | SMTP relay for email links | open | |
| 14 | Telegram bot token | open | |
| 15 | Onramp list (user-chosen links only) | open | |

## Settlement and stats

| # | Check | Status | Result |
|---|---|---|---|
| 16 | Kill-switch drill on solana-test-validator (the EVM half runs as `contracts/test/KillSwitchDrill.t.sol`) | open | Needs `programs/jelly_sol` (Phase 8) first. |
| 17 | Real chain indexer for the volume classifier's funding graph (`@jelly/settlement`'s `FundingGraph`); `MemoryFundingGraph` and `NullFundingGraph` are stand-ins | open | Until built, production should run `NullFundingGraph`, which never over-classifies a job as internal. |
| 18 | Burn bucket feed for `/stats`'s `burns` list (today it is whatever the deployment passes in; nothing reads `BurnBucket.Burned` events yet) | open | |

## Retail (Phase 7 additions)

| # | Check | Status | Result |
|---|---|---|---|
| 19 | A real `PasskeyVerifier` (e.g. `@simplewebauthn/server`): `@jelly/auth`'s `AuthService` is tested against a fake one, since a real WebAuthn ceremony needs a browser or a virtual authenticator | open | |
| 20 | `@jelly/intake`'s generator step is one bounded gateway call with `fetch_url`, not a real multi-query discovery engine; it will under-deliver on broad "find me X" asks | open | |
| 21 | The quote→job flow does not yet consult `@jelly/templates`' registry, so a job built from a template does not record which version it used; `createShare`'s `templateVersion` field is always unset | open | |
| 22 | `self-referral` signals (`sameDevice`, `sameIpPrefix`, `fundingLinked`) are computed by whoever calls `JobService.registerReferral`; no wiring yet connects `@jelly/auth`'s device records or `@jelly/settlement`'s `FundingGraph` to that call | open | |
| 23 | `apps/api`'s `/v1/ws` route needs `websocket` (exported from `apps/api`) passed to `Bun.serve`; there is no production bootstrap yet (same gap as the REST app itself — see §5's day-1 notes on `ViemEscrow`) | open | |
