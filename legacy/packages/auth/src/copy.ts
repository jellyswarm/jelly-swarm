/**
 * User-facing strings for sign-in (§10.1). A copy file: scanned by the copy lint.
 */
export const COPY = {
  emailLinkSent: "Check your email for a one-time link. It works for 15 minutes and only once.",
  emailLinkExpired: "This link has expired or was already used. Request a new one.",
  emailFundingNeedsWallet:
    "An email-only account can run free and credit jobs. To fund a job with money, add a passkey wallet or connect an external wallet.",
  passkeyChallengeExpired: "That passkey request took too long. Try again.",
  deviceCookieInvalid: "Your device could not be verified. Reloading the page will issue a new one.",
  sessionExpired: "Your session has expired. Sign in again.",
  siweMessageExpired: "That sign-in request has expired. Try again.",
  identityTaken: "That sign-in method is already linked to a different account.",
  noRecoveryKey: "We cannot recover a lost passkey for you, because we never hold the key. Add a second passkey or a backup address while you still can.",
} as const;
