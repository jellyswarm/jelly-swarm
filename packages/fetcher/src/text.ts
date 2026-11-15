/**
 * §3.4 text normalisation: NFKC, then whitespace collapse. NFKC folds
 * look-alike forms (full-width digits, non-breaking spaces, ligatures) so a
 * quoted passage can be found on the page it came from.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  copy: "(c)",
  reg: "(R)",
  trade: "(TM)",
  times: "x",
  middot: "·",
  bull: "•",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Visible text of an HTML page: scripts, styles and markup removed, entities decoded, normalised. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return normalizeText(decodeEntities(stripped));
}
