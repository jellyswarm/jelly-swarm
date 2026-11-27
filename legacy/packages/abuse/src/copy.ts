/** User-facing strings for the free tier and abuse controls (§10.3). A copy file: scanned by the copy lint. */
export const COPY = {
  powRequired: "Solve the challenge below before your first job. It takes about a second on a phone.",
  powTooSlow: "That challenge has expired. Request a new one.",
  powWrong: "That answer does not solve the challenge.",
  freeUsedOnThisDevice: "This device has already used its one free job. Fund a job to keep going.",
  freeQuotaForToday: "The free tier has used its budget for today. Fund a job, or join the queue.",
  joinQueue: "join queue",
  outreachRefused: "This looks like outreach to real people rather than research. JellySwarm does not run contact or messaging lists.",
  loginWalledRefused: "One of these targets sits behind a sign-in wall. JellySwarm never scrapes behind a login.",
  bulkPersonalDataRefused: "This looks like a bulk list of private people's data, which the free tier does not run.",
  banned: "This device or account can no longer start jobs. Withdrawals and refunds are not affected.",
} as const;
