/**
 * User-facing strings returned by the job service. This is a copy file: the
 * copy lint (tools/copy-lint) scans it on every build.
 */
export const COPY = {
  notFound: "No such job or quote.",
  quoteExpired: "This quote has expired. Request a new one; the price may differ.",
  quoteInvalid: "This quote could not be verified.",
  itemsRequired: "Give a list of items and the columns to fill. Plain-words requests without a list are not available yet.",
  picketNotPerJob: "Picket is billed by period, not per job.",
  wrongChain: "This quote was made for a different chain.",
  overPlannerBudget: "This job would cost more to run than its price allows. Try fewer columns or a higher tier.",
  notOffered: "That combination of product, tier and size is not offered.",
  payerRequired: "Name the wallet that will pay for this job.",
  grantRequired: "A signed spend grant is needed to pay from a prepaid balance.",
  paymentPending: "Payment has not arrived yet.",
  notFinished: "This job has not finished yet.",
  disputeClosed: "The dispute window for this job has closed.",
  disputeRows: "Name between 1 and 25 rows that passed, each once.",
  runFailed: "The job could not be completed. Your payment is returned when the job expires.",
  keyInactive: "This key is not active yet. Sign the spend grant to activate it.",
  shareNotReady: "This job has no result to share yet.",
  shareTooPrivate: "A wallet job can only be shared privately with the people you choose.",
  shareNotFound: "This link does not point to a job you can see.",
  referralSelf: "This looks like a self-referral, so no credit was given.",
  referralAlreadyUsed: "This account already has a referral on record.",
  referralCapReached: "You have reached this month's referral credit limit.",
  freeTierNotConfigured: "The free tier is not available right now.",
  overFreeTierCap: "This job's price is above what the free tier covers. Pick fewer agents or a lower tier, or pay for it.",
  creditsNotConfigured: "Paying with credits is not available right now.",
  insufficientCredit: "Your credit balance does not cover this job's price.",
} as const;
