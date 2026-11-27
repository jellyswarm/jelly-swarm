import { describe, expect, test } from "bun:test";
import {
  BPS_DENOMINATOR,
  CHAINS,
  FEE_SPLIT_BPS,
  MAX_AGENTS,
  REFUND_CURVE_BPS,
  UnconfirmedChainError,
  formatUsd6,
  ipPrefixOf,
  isBurnEligible,
  loadInfraEnv,
  requireConfirmed,
  splitBps,
  usd6,
  wavesFor,
} from "./index";

describe("hard rules", () => {
  test("agent cap is 247", () => {
    expect(MAX_AGENTS).toBe(247);
  });

  test("fee split is 8000/1000/500/500 and sums to 10000", () => {
    expect(FEE_SPLIT_BPS).toEqual({ operators: 8000, treasury: 1000, checker: 500, burn: 500 });
    expect(Object.values(FEE_SPLIT_BPS).reduce((a, b) => a + b, 0)).toBe(BPS_DENOMINATOR);
  });

  test("refund curve is 100/75/35/0", () => {
    expect([...REFUND_CURVE_BPS]).toEqual([10_000, 7_500, 3_500, 0]);
  });

  test("only real and external_small volume can fund burns", () => {
    expect(isBurnEligible("real")).toBe(true);
    expect(isBurnEligible("external_small")).toBe(true);
    expect(isBurnEligible("incentive")).toBe(false);
    expect(isBurnEligible("internal")).toBe(false);
    expect(isBurnEligible("test")).toBe(false);
  });
});

describe("waves", () => {
  test("600 items run as 3 waves", () => {
    expect(wavesFor(600)).toBe(3);
  });
  test("boundaries", () => {
    expect(wavesFor(1)).toBe(1);
    expect(wavesFor(247)).toBe(1);
    expect(wavesFor(248)).toBe(2);
  });
});

describe("money", () => {
  test("parses and formats", () => {
    expect(usd6("0.25")).toBe(250_000n);
    expect(usd6("3")).toBe(3_000_000n);
    expect(usd6("0.005")).toBe(5_000n);
    expect(formatUsd6(250_000n)).toBe("0.25");
    expect(formatUsd6(1_485_000n)).toBe("1.485");
    expect(formatUsd6(3_000_000n)).toBe("3.00");
  });

  test("rejects floats-in-disguise and over-precision", () => {
    expect(() => usd6("0.1234567")).toThrow();
    expect(() => usd6("-1")).toThrow();
    expect(() => usd6("1e3")).toThrow();
  });

  test("full-width job prices from the overview", () => {
    const job = (perAgent: string) => usd6("0.25") + BigInt(MAX_AGENTS) * usd6(perAgent);
    expect(formatUsd6(job("0.005"))).toBe("1.485"); // overview rounds to $1.49
    expect(formatUsd6(job("0.015"))).toBe("3.955"); // $3.96
    expect(formatUsd6(job("0.04"))).toBe("10.13");
    expect(formatUsd6(usd6("0.25") + 20n * usd6("0.015"))).toBe("0.55");
  });

  test("split always sums to gross; dust goes to the named party", () => {
    for (const gross of [0n, 1n, 3n, 999n, 1_485_000n, 10_130_001n]) {
      const parts = splitBps(gross, FEE_SPLIT_BPS, "treasury");
      expect(parts.operators + parts.treasury + parts.checker + parts.burn).toBe(gross);
    }
    expect(splitBps(1_000_000n, FEE_SPLIT_BPS, "treasury")).toEqual({
      operators: 800_000n,
      treasury: 100_000n,
      checker: 50_000n,
      burn: 50_000n,
    });
  });

  test("split refuses shares that do not sum to 10000", () => {
    expect(() => splitBps(100n, { a: 5000, b: 4000 }, "a")).toThrow();
  });
});

describe("chains", () => {
  test("confirmed chains have an asset", () => {
    expect(requireConfirmed("base").asset.symbol).toBe("USDC");
    expect(requireConfirmed("solana").asset.symbol).toBe("USDC");
  });

  test("unconfirmed chains refuse to be used for money", () => {
    for (const key of ["rhc", "hyperevm", "elysium"] as const) {
      expect(CHAINS[key].confirmed).toBe(false);
      expect(() => requireConfirmed(key)).toThrow(UnconfirmedChainError);
    }
  });
});

describe("env", () => {
  test("falls back to local defaults outside production", () => {
    expect(loadInfraEnv({}).DATABASE_URL).toContain("localhost:5433");
  });
  test("requires every value in production", () => {
    expect(() => loadInfraEnv({ NODE_ENV: "production" })).toThrow();
  });
});

describe("ipPrefixOf", () => {
  test("IPv4 keeps the first three octets, zeroing the fourth", () => {
    expect(ipPrefixOf("203.0.113.42")).toBe("203.0.113.0/24");
  });
  test("two addresses in the same /24 share a prefix; a different one doesn't", () => {
    expect(ipPrefixOf("203.0.113.1")).toBe(ipPrefixOf("203.0.113.254"));
    expect(ipPrefixOf("203.0.113.1")).not.toBe(ipPrefixOf("203.0.114.1"));
  });
  test("IPv6 keeps the first 48 bits (three groups)", () => {
    expect(ipPrefixOf("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
  });
  test("IPv6 '::' compression expands correctly before truncating", () => {
    expect(ipPrefixOf("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(ipPrefixOf("::1")).toBe("0:0:0::/48");
  });
  test("something that isn't an IP address is returned as its own one-member bucket", () => {
    expect(ipPrefixOf("not-an-ip")).toBe("not-an-ip");
  });
});
