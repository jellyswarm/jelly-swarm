import { normalizeText } from "@jelly/fetcher";
import { NUMERIC_TOLERANCE_BPS } from "@jelly/shared";

/**
 * §3.4 deterministic comparisons: is the quoted passage really on the page,
 * and does the passage really support the value?
 */
const fold = (s: string): string => normalizeText(s).toLowerCase();

/** True if the quoted passage appears on the page (after NFKC, whitespace collapse and case folding). */
export function spanOnPage(span: string, pageText: string): boolean {
  const needle = fold(span);
  return needle.length >= 3 && fold(pageText).includes(needle);
}

/** The passage with some text either side, for the judge to read. */
export function contextAround(pageText: string, span: string, radius = 300): string {
  const page = normalizeText(pageText);
  const at = page.toLowerCase().indexOf(fold(span));
  if (at < 0) return normalizeText(span);
  return page.slice(Math.max(0, at - radius), at + span.length + radius);
}

const MULTIPLIER: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
};

const NUMBER =
  /(?<![\w.,])([-+]?)\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s?(thousand|million|billion|trillion|bn|k|m|b|t))?(?![a-z\d])/gi;

/** Every number written in the text: "1,200", "1.2K", "$3.4 million", "-5", "42%". */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of normalizeText(text).matchAll(NUMBER)) {
    const n = Number(m[2]!.replaceAll(",", "")) * (m[3] ? MULTIPLIER[m[3].toLowerCase()]! : 1);
    if (Number.isFinite(n)) out.push(m[1] === "-" ? -n : n);
  }
  return out;
}

/** |value − reference| ≤ reference × bps. The source is the reference. */
export function withinTolerance(value: number, reference: number, bps: number = NUMERIC_TOLERANCE_BPS): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(reference)) return false;
  if (reference === 0) return value === 0;
  return Math.abs(value - reference) <= (Math.abs(reference) * bps) / 10_000 + 1e-12;
}

/** True if some number in the text is within tolerance of the value (default 0.5%). */
export const numberSupported = (value: number, text: string, bps: number = NUMERIC_TOLERANCE_BPS): boolean =>
  extractNumbers(text).some((n) => withinTolerance(value, n, bps));

/** True if the value's text appears in the passage. */
export function textSupported(value: string, span: string): boolean {
  const needle = fold(value);
  return needle.length > 0 && fold(span).includes(needle);
}
