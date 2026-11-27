import { type Cells, type Column, type Item, type JobSpec, UNVERIFIED } from "@jelly/engine";

/**
 * §3.3 step 5: the result table. It is built by code, not by a model, from
 * passed rows only, so it contains exactly what the checker let through.
 */
export type PassedRow = { rowIdx: number; cells: Cells };

export type TableRow = {
  /** The row's index in the job; what a summary citation `[row N]` refers to. */
  rowIdx: number;
  item: string;
  cells: { value: unknown; sourceUrl?: string }[];
};

export type Table = {
  columns: Column[];
  rows: TableRow[];
  /** Cells shown as "unverified". */
  unverifiedCells: number;
};

export function buildTable(spec: JobSpec, passed: readonly PassedRow[]): Table {
  let unverifiedCells = 0;
  const rows = [...passed]
    .sort((a, b) => a.rowIdx - b.rowIdx)
    .map((row): TableRow => {
      const item: Item | undefined = spec.items[row.rowIdx];
      if (!item) throw new Error(`row ${row.rowIdx} is outside the spec`);
      return {
        rowIdx: row.rowIdx,
        item: item.raw,
        cells: spec.columns.map((col) => {
          const cell = row.cells[col.name];
          const value = cell?.value ?? UNVERIFIED;
          if (value === UNVERIFIED) unverifiedCells++;
          return { value, ...(cell?.source.url ? { sourceUrl: cell.source.url } : {}) };
        }),
      };
    });
  return { columns: spec.columns, rows, unverifiedCells };
}

const show = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/**
 * CSV for spreadsheets. A cell that starts with = + - @ (or a tab or carriage
 * return) is prefixed with a quote mark, so a value scraped from a web page
 * can never run as a formula when the file is opened.
 */
export function toCsv(table: Table): string {
  const cell = (v: unknown): string => {
    let s = show(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const header = ["row", "item", ...table.columns.flatMap((c) => [c.name, `${c.name} source`])];
  const lines = table.rows.map((r) => [r.rowIdx, r.item, ...r.cells.flatMap((c) => [c.value, c.sourceUrl ?? ""])]);
  return [header, ...lines].map((line) => line.map(cell).join(",")).join("\r\n");
}

/** Markdown table. Pipes, line breaks and link brackets in values are escaped. */
export function toMarkdown(table: Table): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").replace(/([[\]<>`*_])/g, "\\$1");
  const cell = (c: TableRow["cells"][number]) => {
    const text = esc(show(c.value));
    // Only http(s) links, and the URL goes inside <> so its characters cannot break out.
    return c.sourceUrl && /^https?:\/\//i.test(c.sourceUrl) ? `${text} ([source](<${c.sourceUrl.replace(/[<>\s]/g, "")}>))` : text;
  };
  const header = ["row", "item", ...table.columns.map((c) => esc(c.name))];
  const lines = table.rows.map((r) => [String(r.rowIdx), esc(r.item), ...r.cells.map(cell)]);
  return [header, header.map(() => "---"), ...lines].map((l) => `| ${l.join(" | ")} |`).join("\n");
}

export const toJson = (table: Table): string =>
  JSON.stringify({
    columns: table.columns.map((c) => ({ name: c.name, type: c.type })),
    rows: table.rows.map((r) => ({
      row: r.rowIdx,
      item: r.item,
      cells: Object.fromEntries(table.columns.map((c, i) => [c.name, r.cells[i]])),
    })),
    unverifiedCells: table.unverifiedCells,
  });
