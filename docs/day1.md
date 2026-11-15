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
