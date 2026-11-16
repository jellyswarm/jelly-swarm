import type { AccountStore } from "@jelly/auth";
import { VOLUME } from "@jelly/shared";
import type { FundingGraph } from "./funding-graph";

/**
 * §11.4 self-referral detection: wires `@jelly/auth`'s device records and
 * `@jelly/settlement`'s `FundingGraph` into the three signals
 * `JobService.registerReferral` takes (day1.md #22). Called by whoever owns
 * the HTTP request (the referee's device cookie, wallets), before passing
 * the result into `registerReferral`.
 *
 * `sameIpPrefix` stays caller-supplied: no package yet stores "which IP
 * prefixes has this account's devices used, and when" to query by account
 * (only `free_grants` ties a single device to a single prefix, for the
 * free-tier daily cap, not for lookup by account) — a real fix needs that
 * history to exist first, which is its own, separable piece of work.
 */
export type ReferralSignalInputs = {
  /** The device cookie the referee is signing up with right now. */
  refereeDeviceId: string;
  /** Wallets the referee has linked or is linking. */
  refereeWalletAddresses: readonly string[];
  referrerAccountId: string;
  /** Wallets on file for the referrer; an empty list makes fundingLinked always false (nothing to check against). */
  referrerWalletAddresses: readonly string[];
  sameIpPrefix: boolean;
};

export type ReferralSignals = { sameDevice: boolean; sameIpPrefix: boolean; fundingLinked: boolean };

export async function computeReferralSignals(
  deps: { accounts: AccountStore; fundingGraph: FundingGraph },
  input: ReferralSignalInputs,
  nowMs: number,
): Promise<ReferralSignals> {
  const device = await deps.accounts.getDevice(input.refereeDeviceId);
  const sameDevice = device?.accountId === input.referrerAccountId;

  const referrerWallets = new Set(input.referrerWalletAddresses.map((a) => a.toLowerCase()));
  let fundingLinked = false;
  if (referrerWallets.size > 0) {
    for (const wallet of input.refereeWalletAddresses) {
      if (await deps.fundingGraph.isStudioLinked(wallet, referrerWallets, VOLUME.fundingHops, VOLUME.fundingLookbackMs, nowMs)) {
        fundingLinked = true;
        break;
      }
    }
  }

  return { sameDevice, sameIpPrefix: input.sameIpPrefix, fundingLinked };
}
