/**
 * User-facing strings for `/stats` (§16 "Honest limits"). A copy file:
 * scanned by the copy lint.
 */
export const COPY = {
  refundsOnChain:
    "Every refund figure here is read from the same on-chain escrow a client's own refund comes from; nothing here can be edited after the fact.",
  studioOperators:
    "We run the checkers and workers at launch. Until outside operators join, the 80% operator share goes to our own operator wallets.",
  studioCheckers:
    'Until outside checkers stake in, "independent" means a separate process, key and model family, not a separate organisation.',
  pageTitle: "JellySwarm volume and refunds",
} as const;
