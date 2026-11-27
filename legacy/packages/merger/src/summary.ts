import { extractNumbers, withinTolerance } from "@jelly/checker";
import { UNVERIFIED } from "@jelly/engine";
import type { Table } from "./table";

/**
 * §3.3 step 5 and §13: the merger may only summarise. It must not add facts,
 * and any number in the summary must cite a row.
 *
 * A summary passes only if every sentence that contains a number:
 *   - cites at least one row as `[row N]` (or `[rows 3, 7]`),
 *   - cites only rows that exist in the table, and
 *   - uses only numbers found in those rows, or a whole number no larger than
 *     the row count (a count of rows, such as "3 of 12").
 */
const CITATION = /\[rows?\s+(\d+(?:\s*(?:,|and)\s*\d+)*)\]/gi;

export type SummaryCheck = { ok: true } | { ok: false; reason: string };

export const MAX_SUMMARY_CHARS = 4000;

export function validateSummary(summary: string, table: Table): SummaryCheck {
  const text = summary.trim();
  if (text === "") return { ok: false, reason: "summary is empty" };
  if (text.length > MAX_SUMMARY_CHARS) return { ok: false, reason: "summary is too long" };
  // A summary is prose. Links and markup could smuggle in content that is not from the rows.
  if (/https?:\/\/|<[a-z!/]|\]\(/i.test(text)) return { ok: false, reason: "summary must not contain links or markup" };

  const byIdx = new Map(table.rows.map((r) => [r.rowIdx, r]));
  const numbersIn = (rowIdx: number): number[] => {
    const row = byIdx.get(rowIdx)!;
    const out = extractNumbers(row.item);
    for (const c of row.cells) {
      if (typeof c.value === "number") out.push(c.value);
      else if (typeof c.value === "string" && c.value !== UNVERIFIED) out.push(...extractNumbers(c.value.replaceAll("-", " ")));
    }
    return out;
  };

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const cited: number[] = [];
    const prose = sentence.replace(CITATION, (_m, list: string) => {
      cited.push(...list.split(/\s*(?:,|and)\s*/).map(Number));
      return " ";
    });
    for (const idx of cited) {
      if (!byIdx.has(idx)) return { ok: false, reason: `cites row ${idx}, which is not in the table` };
    }
    const numbers = extractNumbers(prose);
    if (numbers.length === 0) continue;
    if (cited.length === 0) return { ok: false, reason: `a number has no row citation: "${sentence.trim().slice(0, 80)}"` };

    const allowed = cited.flatMap(numbersIn);
    for (const n of numbers) {
      const isRowCount = Number.isInteger(n) && n >= 0 && n <= table.rows.length;
      if (!isRowCount && !allowed.some((a) => withinTolerance(n, a))) {
        return { ok: false, reason: `the number ${n} is not in the rows it cites` };
      }
    }
  }
  return { ok: true };
}
