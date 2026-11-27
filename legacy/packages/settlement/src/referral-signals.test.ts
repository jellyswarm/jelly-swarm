import { MemoryAccountStore } from "@jelly/auth";
import { describe, expect, test } from "bun:test";
import { computeReferralSignals, MemoryFundingGraph } from "./index";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

describe("computeReferralSignals (§11.4, day1.md #22)", () => {
  test("sameDevice is true only when the referee's device is already tied to the referrer's account", async () => {
    const accounts = new MemoryAccountStore();
    const fundingGraph = new MemoryFundingGraph();
    await accounts.putDevice({ id: "dev-shared", accountId: "referrer-1", powPenaltyBits: 0 });

    const linked = await computeReferralSignals(
      { accounts, fundingGraph },
      { refereeDeviceId: "dev-shared", refereeWalletAddresses: [], referrerAccountId: "referrer-1", referrerWalletAddresses: [], sameIpPrefix: false },
      NOW,
    );
    expect(linked.sameDevice).toBe(true);

    const unlinked = await computeReferralSignals(
      { accounts, fundingGraph },
      { refereeDeviceId: "dev-own", refereeWalletAddresses: [], referrerAccountId: "referrer-1", referrerWalletAddresses: [], sameIpPrefix: false },
      NOW,
    );
    expect(unlinked.sameDevice).toBe(false);
  });

  test("fundingLinked is true when a referee wallet is within the hop limit of a referrer wallet", async () => {
    const accounts = new MemoryAccountStore();
    const fundingGraph = new MemoryFundingGraph([{ from: "0xreferrer", to: "0xreferee", atMs: NOW - DAY }]);

    const result = await computeReferralSignals(
      { accounts, fundingGraph },
      {
        refereeDeviceId: "dev-x",
        refereeWalletAddresses: ["0xreferee"],
        referrerAccountId: "referrer-1",
        referrerWalletAddresses: ["0xreferrer"],
        sameIpPrefix: false,
      },
      NOW,
    );
    expect(result.fundingLinked).toBe(true);
  });

  test("fundingLinked is false when the referrer has no wallets on file to check against", async () => {
    const accounts = new MemoryAccountStore();
    const fundingGraph = new MemoryFundingGraph([{ from: "0xreferrer", to: "0xreferee", atMs: NOW - DAY }]);

    const result = await computeReferralSignals(
      { accounts, fundingGraph },
      { refereeDeviceId: "dev-x", refereeWalletAddresses: ["0xreferee"], referrerAccountId: "referrer-1", referrerWalletAddresses: [], sameIpPrefix: false },
      NOW,
    );
    expect(result.fundingLinked).toBe(false);
  });

  test("sameIpPrefix passes straight through: no package yet stores IP-prefix history by account", async () => {
    const accounts = new MemoryAccountStore();
    const fundingGraph = new MemoryFundingGraph();
    const result = await computeReferralSignals(
      { accounts, fundingGraph },
      { refereeDeviceId: "dev-x", refereeWalletAddresses: [], referrerAccountId: "referrer-1", referrerWalletAddresses: [], sameIpPrefix: true },
      NOW,
    );
    expect(result.sameIpPrefix).toBe(true);
  });
});
