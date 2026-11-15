/**
 * Copy lint (§0.8 and the naming rule in docs/source/core-backend.txt).
 *
 * Convention: every user-facing string lives in a "copy file" — a file named
 * `copy.ts` / `*.copy.ts(x)`, anything under a `copy/` directory, or a
 * template under `templates/`. This lint scans those files and fails the
 * build on banned wording. A line can opt out with `copy-lint-ignore` and a
 * reason, which reviewers should treat as an exception to justify.
 */

export type Finding = { file: string; line: number; rule: string; text: string };

type Rule = { id: string; pattern: RegExp; message: string };

const RULES: Rule[] = [
  { id: "banned:apy", pattern: /\bAPY\b/i, message: 'never say "APY"' },
  { id: "banned:apr", pattern: /\bAPR\b/i, message: 'never say "APR"' },
  { id: "banned:yield", pattern: /\byield(s|ed|ing)?\b/i, message: 'never say "yield"' },
  { id: "banned:earn", pattern: /\bearn(s|ed|ing|ings)?\b/i, message: 'never say "earn"' },
  { id: "banned:passive-income", pattern: /\bpassive\s+income\b/i, message: 'never say "passive income"' },
  { id: "banned:guaranteed", pattern: /\bguarantee[ds]?\b/i, message: 'never say "guaranteed"' },
  { id: "banned:partner", pattern: /\bpartner(s|ed|ing|ship|ships)?\b/i, message: 'never say "partner"' },
  {
    id: "banned:24/7",
    pattern: /\b24\s*[/x×-]\s*7\b/i,
    message: 'write always-on service as "around the clock"',
  },
  {
    id: "cap:247-wording",
    // "247 agents" must read "of 247 agents" or "up to 247 agents".
    pattern: /(?<!\bof )(?<!\bup to )\b247 agents\b/i,
    message: 'write the cap as "of 247 agents" or "up to 247 agents"',
  },
  {
    id: "brand:internal",
    pattern: /\b(muster|anyroute|trellis|offpeak)\b/i,
    message: "internal studio brand names must never reach a public string",
  },
];

/** Globs (relative to the repo root) that hold user-facing strings. */
export const COPY_GLOBS = [
  "**/copy.{ts,tsx}",
  "**/*.copy.{ts,tsx}",
  "**/copy/**/*.{ts,tsx,json,md}",
  "templates/**/*.ts",
];

const EXCLUDE = /(^|[\\/])(node_modules|\.tsbuild|dist|docs|\.git)([\\/]|$)|[\\/]copy-lint[\\/]/;

export function lintText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (raw.includes("copy-lint-ignore")) return;
    for (const rule of RULES) {
      if (rule.pattern.test(raw)) {
        findings.push({ file, line: i + 1, rule: rule.id, text: `${rule.message}: ${raw.trim().slice(0, 120)}` });
      }
    }
  });
  return findings;
}

export async function lintRepo(root: string): Promise<{ files: string[]; findings: Finding[] }> {
  const files = new Set<string>();
  for (const pattern of COPY_GLOBS) {
    for await (const f of new Bun.Glob(pattern).scan({ cwd: root, dot: false })) {
      if (!EXCLUDE.test(f)) files.add(f.replaceAll("\\", "/"));
    }
  }
  const findings: Finding[] = [];
  for (const f of [...files].sort()) {
    findings.push(...lintText(f, await Bun.file(`${root}/${f}`).text()));
  }
  return { files: [...files].sort(), findings };
}
