import { COPY } from "./copy";

/**
 * §10.3 "The free tier uses a stricter classifier: no outreach, no
 * login-walled targets, no DoS shapes, no bulk lists of private people's
 * data." This is a best-effort heuristic filter over the task text, not a
 * guarantee: it exists to catch the obvious, cheap-to-block cases before any
 * model time is spent, and it is meant to sit in front of the model-based
 * checks that already exist elsewhere (the worker manifest has no send/buy
 * tools at all; `@jelly/engine`'s wallet rule forces Sealed on wallet lists).
 */
export type PolicyRefusal = "outreach" | "login_walled" | "dos_shape" | "bulk_personal_data";

const OUTREACH = /\b(cold\s*email|outreach|mail\s*merge|send\s+(an?\s+)?(email|message|dm)s?\s+to|blast|spam\s+list|contact\s+list|lead\s*gen)\b/i;
const LOGIN_WALLED = /\b(behind\s+(a\s+)?login|requires?\s+sign[\s-]?in|members?[\s-]?only\s+(page|site|area)|paywall)\b/i;
const DOS_SHAPE = /\b(ddos|flood|hammer|brute[\s-]?force|stress[\s-]?test|every\s+\d+\s*(ms|millisecond)s?|as\s+fast\s+as\s+possible)\b/i;
const BULK_PERSONAL = /\b(home\s+address(es)?|phone\s+numbers?|social\s+security|ssn|date\s+of\s+birth|personal\s+emails?\s+of|private\s+(citizens?|individuals?))\b/i;

const RULES: [RegExp, PolicyRefusal][] = [
  [OUTREACH, "outreach"],
  [LOGIN_WALLED, "login_walled"],
  [DOS_SHAPE, "dos_shape"],
  [BULK_PERSONAL, "bulk_personal_data"],
];

export const REFUSAL_MESSAGE: Record<PolicyRefusal, string> = {
  outreach: COPY.outreachRefused,
  login_walled: COPY.loginWalledRefused,
  dos_shape: COPY.outreachRefused,
  bulk_personal_data: COPY.bulkPersonalDataRefused,
};

export type PolicyCheck = { refusal: PolicyRefusal; message: string } | null;

/** Checks the task text and, loosely, the item list for the free tier's stricter rules. */
export function checkFreeTierPolicy(task: string, items: readonly string[] = []): PolicyCheck {
  const text = `${task}\n${items.join("\n")}`;
  for (const [pattern, refusal] of RULES) {
    if (pattern.test(text)) return { refusal, message: REFUSAL_MESSAGE[refusal] };
  }
  // A long, uniform list of personal-looking name/email pairs with no other context reads as a contact list.
  if (items.length >= 20 && items.every((i) => /^[\w.+-]+@[\w.-]+\.\w+$/.test(i.trim()))) {
    return { refusal: "bulk_personal_data", message: REFUSAL_MESSAGE.bulk_personal_data };
  }
  return null;
}
