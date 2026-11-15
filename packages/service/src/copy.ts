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
} as const;
