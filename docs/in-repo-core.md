# Pieces written in this repo instead of imported

The build doc (`source/core-backend.txt`) says to import a shared swarm core
from a sibling repo. That repo is not available, so each piece it would have
supplied is written here, behind the interface the build doc names. If the
original core becomes available, a piece can be swapped for it without
touching its callers.

These are first implementations written from the doc's description. The
contracts in particular have not been audited and must be before they hold
real funds.

| Build doc expects | Written here as | Phase |
|---|---|---|
| Budget guard (atomic Redis reservations) | `packages/budget-guard` | 1 |
| Queue conventions (names, retries, dead-letter queue) | `packages/queues` | 2 |
| Policy: typed envelopes, role manifests, taint rules | `packages/policy` | 1 |
| Escrow contract (ERC-8183) | `contracts/src/JellyJob.sol` (standalone, not inherited; written from the doc's description of the standard) | 4 |
| Split hook semantics and refund curve (100/75/35/0) | `contracts/src/RowSplit.sol`; `RefundCurve` in `Checkers.sol` | 4 |
| Receipt log, root mode | `contracts/src/ReceiptRoot.sol` | 4 |
| Fee router | `contracts/src/Fees.sol` | 4 |
| Checker panels (stake, audit and dispute rounds) | `CheckerNet` in `contracts/src/Checkers.sol` (first version; panel draw and voting rules are ours) | 4 |
| Admin timelock (48h) and guardian halt | `contracts/src/Admin.sol` | 4 |
| x402 facilitator fork | `packages/x402` (own-key EVM facilitator plus an HTTP fallback, not a fork) | 5 |
| Chain indexer | `apps/indexer` | 6 |
| Volume classifier (3-hop rule) | `apps/meter` | 6 |
| ACP v2 payee mode | deferred until the live ABI is confirmed (day-1 check 3) | — |
| Solana split program | `programs/jelly_split` | 8 |

Naming rule: none of the studio's internal brand names may appear in a public
string, API response, user-visible log, EIP-712 domain or contract name. The
copy lint (`tools/copy-lint`) enforces this for copy files.
