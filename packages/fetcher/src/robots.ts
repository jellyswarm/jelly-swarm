/**
 * robots.txt (RFC 9309). The engine never fetches a path a site disallows
 * for our user agent (§13: "Robots.txt is respected").
 */
export type RobotsRules = { allow: string[]; disallow: string[] };

/** Rules for `agent`: its own group if the file names it, otherwise the `*` group. */
export function parseRobots(text: string, agent: string): RobotsRules {
  const token = agent.toLowerCase();
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | undefined;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [] } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" && value) current.rules.allow.push(value);
    // An empty Disallow means "allow everything" and adds no rule.
    if (field === "disallow" && value) current.rules.disallow.push(value);
  }

  const merge = (match: (a: string) => boolean): RobotsRules | undefined => {
    const hits = groups.filter((g) => g.agents.some(match));
    if (hits.length === 0) return undefined;
    return { allow: hits.flatMap((g) => g.rules.allow), disallow: hits.flatMap((g) => g.rules.disallow) };
  };
  return merge((a) => a !== "*" && token.includes(a)) ?? merge((a) => a === "*") ?? { allow: [], disallow: [] };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Longest matching rule wins; on a tie, allow wins. No matching rule means allowed. */
export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  const longest = (patterns: string[]) =>
    patterns.reduce((best, p) => (patternToRegExp(p).test(pathAndQuery) && p.length > best ? p.length : best), -1);
  const allow = longest(rules.allow);
  const disallow = longest(rules.disallow);
  return disallow === -1 || allow >= disallow;
}
