import { describe, expect, test } from "bun:test";
import { USAGE, makeGateway, makeJob } from "@jelly/checker/src/testkit";
import { type Cells, type Column, UNVERIFIED } from "@jelly/engine";
import { type MockHandler, mockResponse } from "@jelly/gateway";
import { MERGER_PROMPT, Merger, type PassedRow, buildTable, toCsv, toJson, toMarkdown, validateSummary } from "./index";

const COLS: Column[] = [
  { name: "holders", type: "number", needsSource: true },
  { name: "locked", type: "bool", needsSource: true },
  { name: "note", type: "text", needsSource: false },
];
const ITEMS = ["alpha", "beta", "gamma", "delta"];
const row = (rowIdx: number, holders: unknown, locked: unknown, note: unknown = "ok"): PassedRow => ({
  rowIdx,
  cells: {
    holders: { value: holders, source: holders === UNVERIFIED ? {} : { url: `https://example.com/${rowIdx}`, quoteSpan: "x" } },
    locked: { value: locked, source: {} },
    note: { value: note, source: {} },
  } as Cells,
});
// Row 1 (beta) failed the checker and is not passed in.
const PASSED = [row(3, 4500, false), row(0, 1200, true), row(2, UNVERIFIED, true)];
const job = () => makeJob(ITEMS, COLS);
const table = () => buildTable(job().spec, PASSED);

describe("table (§3.3 step 5)", () => {
  test("holds passed rows only, in row order, and counts unverified cells", () => {
    const t = table();
    expect(t.rows.map((r) => [r.rowIdx, r.item])).toEqual([
      [0, "alpha"],
      [2, "gamma"],
      [3, "delta"],
    ]);
    expect(t.unverifiedCells).toBe(1);
    expect(t.rows[0]!.cells[0]).toEqual({ value: 1200, sourceUrl: "https://example.com/0" });
    expect(JSON.stringify(t)).not.toContain("beta");
  });

  test("a row outside the spec is an error", () => {
    expect(() => buildTable(job().spec, [row(9, 1, true)])).toThrow();
  });

  test("CSV neutralises spreadsheet formulas and quotes separators", () => {
    const hostile = buildTable(job().spec, [
      row(0, 1, true, '=HYPERLINK("http://evil.example","click")'),
      row(2, 2, true, "+1+1"),
      row(3, -3, false, 'has, comma and "quote"\nnewline'),
    ]);
    const lines = toCsv(hostile).split("\r\n");
    expect(lines[0]).toBe("row,item,holders,holders source,locked,locked source,note,note source");
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(lines[2]).toContain(",'+1+1,");
    expect(lines[3]).toContain(",-3,"); // a real negative number is left alone
    expect(toCsv(hostile)).toContain('"has, comma and ""quote""\nnewline"');
  });

  test("Markdown escapes pipes and markup, and links only http(s) sources", () => {
    const hostile = buildTable(job().spec, [row(0, 1, true, "a | b [x](javascript:alert(1)) <img src=x>\nnext")]);
    const md = toMarkdown(hostile);
    expect(md.split("\n")).toHaveLength(3);
    expect(md).toContain("a \\| b \\[x\\](javascript:alert(1)) \\<img src=x\\> next");
    expect(md).toContain("1 ([source](<https://example.com/0>))");
    const js = buildTable(job().spec, [
      { rowIdx: 0, cells: { holders: { value: 1, source: { url: "javascript:alert(1)" } } } as Cells },
    ]);
    expect(toMarkdown(js)).not.toContain("javascript:");
  });

  test("JSON carries the same rows", () => {
    const parsed = JSON.parse(toJson(table()));
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[1]).toMatchObject({ row: 2, item: "gamma", cells: { holders: { value: "unverified" } } });
    expect(parsed.unverifiedCells).toBe(1);
  });
});

describe("summary rule: every number cites a row (§13)", () => {
  const check = (s: string) => validateSummary(s, table());

  test.each([
    "Alpha has 1,200 holders [row 0] and delta has 4,500 [row 3].",
    "Alpha has 1.2K holders [row 0].",
    "Two of the 3 tokens have locked liquidity [rows 0, 2].",
    "Liquidity is locked for alpha and gamma. Delta is not locked.",
    "Delta leads with 4,500 holders, ahead of alpha's 1,200 [rows 3 and 0].",
  ])("accepts %p", (s) => {
    expect(check(s)).toEqual({ ok: true });
  });

  test.each([
    ["Alpha has 1,200 holders.", "no row citation"],
    ["Alpha has 9,999 holders [row 0].", "not in the rows it cites"],
    ["Alpha has 4,500 holders [row 0].", "not in the rows it cites"], // delta's number, wrong row
    ["Beta has 1,200 holders [row 1].", "not in the table"], // row 1 was refunded
    ["Holders grew 35% this month [row 0].", "not in the rows it cites"],
    ["Alpha has 1,200 holders [row 0]. The average is 2,850 holders.", "no row citation"],
    ["See https://evil.example for more [row 0].", "links or markup"],
    ["Alpha is locked. <script>alert(1)</script>", "links or markup"],
    ["Alpha [click](x) is locked.", "links or markup"],
    ["", "empty"],
    ["x".repeat(5000), "too long"],
  ])("rejects %p", (s, why) => {
    const r = check(s);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(why);
  });

  test("an unverified cell contributes no number", () => {
    expect(check("Gamma has 1,200 holders [row 2].").ok).toBe(false);
  });
});

describe("merger (§3.3 step 5)", () => {
  const GOOD = "Alpha has 1,200 holders [row 0]. Delta has 4,500 [row 3]. Gamma's holder count is unverified.";
  const BAD = "Alpha has 1,200 holders and is a strong buy at 50x upside.";
  const says = (...answers: string[]): MockHandler => (_h, _r, i) => mockResponse({ content: answers[i] ?? answers.at(-1)!, usage: USAGE });

  test("a summary that follows the rule is delivered with the table", async () => {
    const g = makeGateway(says(GOOD));
    const r = await new Merger({ gateway: g.gateway }).merge(job(), PASSED);
    expect(r).toMatchObject({ summary: GOOD, summaryAttempts: 1, summaryRejections: [] });
    expect(r.table.rows).toHaveLength(3);
    expect(g.provider.calls[0]!.req.model).toBe("deepseek-v4-pro");
  });

  test("a summary that breaks the rule is retried once", async () => {
    const g = makeGateway(says(BAD, GOOD));
    const r = await new Merger({ gateway: g.gateway }).merge(job(), PASSED);
    expect(r).toMatchObject({ summary: GOOD, summaryAttempts: 2 });
    expect(r.summaryRejections).toHaveLength(1);
    expect(g.provider.calls).toHaveLength(2);
  });

  test("two bad summaries: the table is delivered without one", async () => {
    const g = makeGateway(says(BAD, BAD, GOOD));
    const r = await new Merger({ gateway: g.gateway }).merge(job(), PASSED);
    expect(r.summary).toBeNull();
    expect(r.summaryAttempts).toBe(2);
    expect(r.summaryRejections).toHaveLength(2);
    expect(r.table.rows).toHaveLength(3);
    expect(g.provider.calls).toHaveLength(2); // never a third try
  });

  test("the merger model sees only passed rows, as data", async () => {
    const g = makeGateway(says(GOOD));
    await new Merger({ gateway: g.gateway }).merge(job(), PASSED);
    const req = g.provider.calls[0]!.req;
    expect(req.system).toBe(MERGER_PROMPT);
    expect(req.tools).toEqual([]);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
    const body = req.messages[0]!.content;
    expect(body).toStartWith("<data-block>");
    expect(body).toContain('"item":"alpha"');
    expect(body).not.toContain("beta"); // the refunded row never reaches the merger
    expect(body).not.toContain("quoteSpan"); // nor do sources or worker text
  });

  test("with no passed rows there is nothing to summarise and no call is made", async () => {
    const g = makeGateway(says(GOOD));
    const r = await new Merger({ gateway: g.gateway }).merge(job(), []);
    expect(r).toMatchObject({ summary: null, summaryAttempts: 0 });
    expect(r.table.rows).toEqual([]);
    expect(g.provider.calls).toHaveLength(0);
  });

  test("if the merger cannot run, the table still ships", async () => {
    const g = makeGateway(says(GOOD));
    const broke = makeJob(ITEMS, COLS, { quoteMicros: 1n });
    const r = await new Merger({ gateway: g.gateway }).merge(broke, PASSED);
    expect(r.summary).toBeNull();
    expect(r.summaryRejections).toEqual(["merger unavailable: BudgetExceeded"]);
    expect(r.table.rows).toHaveLength(3);
  });
});
