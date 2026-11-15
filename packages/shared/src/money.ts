import { BPS_DENOMINATOR } from "./constants";

/**
 * All money is integer micro-dollars (6 decimals, matching USDC/USDG), held
 * as bigint. Floats never touch an amount.
 */
export type Usd6 = bigint;

export const USD6 = 1_000_000n;

/** Parse a decimal dollar string ("0.25", "3") into micro-dollars. Rejects more than 6 decimals. */
export function usd6(dollars: string): Usd6 {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(dollars);
  if (!m) throw new Error(`invalid dollar amount: ${dollars}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0"));
  return whole * USD6 + frac;
}

/** Format micro-dollars as a dollar string with at least 2 decimals ("0.25", "1.4925"). */
export function formatUsd6(amount: Usd6): string {
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / USD6;
  let frac = (abs % USD6).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${sign}${whole}.${frac}`;
}

/** amount × bps / 10_000, rounded down. */
export function bps(amount: Usd6, basisPoints: number): Usd6 {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) throw new Error(`invalid bps: ${basisPoints}`);
  return (amount * BigInt(basisPoints)) / BigInt(BPS_DENOMINATOR);
}

/**
 * Split `gross` by basis-point shares that sum to 10_000. Each share rounds
 * down; the rounding dust goes to `dustTo`, so the parts always sum to gross.
 */
export function splitBps<K extends string>(gross: Usd6, shares: Record<K, number>, dustTo: NoInfer<K>): Record<K, Usd6> {
  const keys = Object.keys(shares) as K[];
  const total = keys.reduce((s, k) => s + shares[k], 0);
  if (total !== BPS_DENOMINATOR) throw new Error(`shares must sum to ${BPS_DENOMINATOR}, got ${total}`);
  const out = {} as Record<K, Usd6>;
  let paid = 0n;
  for (const k of keys) {
    out[k] = bps(gross, shares[k]);
    paid += out[k];
  }
  out[dustTo] += gross - paid;
  return out;
}
