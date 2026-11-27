import { describe, expect, test } from "bun:test";
import { FetchBlocked, Fetcher, assertPublicUrl, htmlToText, isAllowed, isPrivateAddress, normalizeText, parseRobots } from "./index";

const PUBLIC = "93.184.216.34";
const resolve = async (host: string) => {
  if (host === "rebind.example") return [PUBLIC, "10.0.0.5"];
  if (host === "inside.example") return ["192.168.1.10"];
  if (host === "v6inside.example") return ["fd00::1"];
  if (host === "nxdomain.example") throw new Error("ENOTFOUND");
  return [PUBLIC];
};
const reason = (p: Promise<unknown>) => p.then(() => "allowed", (e) => (e instanceof FetchBlocked ? e.reason : `other: ${e}`));
const guard = (url: string, blockedHosts?: string[]) => reason(assertPublicUrl(url, { resolve, ...(blockedHosts ? { blockedHosts } : {}) }));

describe("SSRF guard (§13)", () => {
  test.each([
    "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "127.0.0.1", "127.9.9.9",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "::ffff:7f00:1", "64:ff9b::a00:1", "2002:c0a8:0101::1", "::127.0.0.1", "not-an-ip", "",
  ])("%p is not a public address", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "%p is public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  test.each([
    ["http://127.0.0.1/", "private_address"],
    ["http://2130706433/", "private_address"], // decimal form of 127.0.0.1
    ["http://0x7f.0.0.1/", "private_address"],
    ["http://[::1]/", "private_address"],
    ["http://[::ffff:169.254.169.254]/latest/meta-data/", "private_address"],
    ["http://169.254.169.254/latest/meta-data/", "private_address"],
    ["http://localhost/", "blocked_host"],
    ["http://app.localhost/", "blocked_host"],
    ["http://metadata.google.internal/", "blocked_host"],
    ["http://db.internal/", "blocked_host"],
    ["http://intranet/", "blocked_host"],
    ["http://printer.local/", "blocked_host"],
    ["http://inside.example/", "private_address"],
    ["http://v6inside.example/", "private_address"],
    ["http://rebind.example/", "private_address"], // one private record is enough
    ["http://nxdomain.example/", "dns"],
    ["https://user:pass@example.com/", "credentials"],
    ["https://example.com:8443/", "port"],
    ["http://example.com:6379/", "port"],
    ["file:///etc/passwd", "scheme"],
    ["ftp://example.com/", "scheme"],
    ["gopher://example.com/", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["not a url", "scheme"],
  ])("%p is refused (%s)", async (url, why) => {
    expect(await guard(url)).toBe(why);
  });

  test("ordinary public pages are allowed", async () => {
    for (const url of ["https://example.com/a?b=1", "http://example.com:80/", "https://sub.example.co.uk:443/x"]) {
      expect(await guard(url)).toBe("allowed");
    }
  });

  test("a block list covers the host and its subdomains", async () => {
    expect(await guard("https://walled.example/x", ["walled.example"])).toBe("blocked_host");
    expect(await guard("https://m.walled.example/x", ["walled.example"])).toBe("blocked_host");
    expect(await guard("https://notwalled.example/x", ["walled.example"])).toBe("allowed");
  });
});

describe("robots.txt", () => {
  const file = `
# comment
User-agent: *
Disallow: /private/
Allow: /private/press/
Disallow: /*.pdf$

User-agent: JellySwarmBot
Disallow: /no-bots/
`;
  test("our own group is used when the file names us; otherwise the * group", () => {
    const ours = parseRobots(file, "JellySwarmBot/1.0");
    expect(isAllowed(ours, "/no-bots/x")).toBe(false);
    expect(isAllowed(ours, "/private/x")).toBe(true); // the * group no longer applies
    const other = parseRobots(file, "SomeOtherBot");
    expect(isAllowed(other, "/private/x")).toBe(false);
    expect(isAllowed(other, "/no-bots/x")).toBe(true);
  });

  test("longest match wins, allow wins ties, wildcards and $ work", () => {
    const r = parseRobots(file, "x");
    expect(isAllowed(r, "/private/press/2026")).toBe(true);
    expect(isAllowed(r, "/private/other")).toBe(false);
    expect(isAllowed(r, "/docs/report.pdf")).toBe(false);
    expect(isAllowed(r, "/docs/report.pdf?x=1")).toBe(true);
    expect(isAllowed(r, "/public")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /a\nAllow: /a", "x"), "/a")).toBe(true);
  });

  test("an empty Disallow or an empty file allows everything; Disallow: / blocks everything", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:", "x"), "/anything")).toBe(true);
    expect(isAllowed(parseRobots("", "x"), "/anything")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /", "x"), "/anything")).toBe(false);
  });
});

describe("text normalisation (§3.4)", () => {
  test("NFKC folds full-width digits, non-breaking spaces and curly quotes", () => {
    expect(normalizeText("１２００ holders  \n “locked”  ‘yes’ — ok")).toBe("1200 holders \"locked\" 'yes' - ok");
    expect(normalizeText("zero​width")).toBe("zerowidth");
  });

  test("HTML becomes visible text: scripts, styles and comments are dropped, entities decoded", () => {
    const html = `<html><head><title>T</title><style>p{color:red}</style></head><body>
      <script>var holders = 999999;</script><!-- hidden 888 -->
      <h1>Token&nbsp;X</h1><p>Holders: <b>1,200</b> &amp; rising &#8212; locked &lt;12 months&gt;</p></body></html>`;
    expect(htmlToText(html)).toBe("Token X Holders: 1,200 & rising - locked <12 months>");
  });
});

// ───────────────────────────── fetcher ─────────────────────────────

type Route = { status?: number; body?: string; type?: string; location?: string };
function web(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fake = (async (input: URL | string | Request) => {
    const url = input.toString();
    seen.push(url);
    const r = routes[url];
    if (!r) return new Response("nope", { status: 404 });
    return new Response(r.body ?? "", {
      status: r.status ?? 200,
      headers: { "content-type": r.type ?? "text/html; charset=utf-8", ...(r.location ? { location: r.location } : {}) },
    });
  }) as typeof fetch;
  return { fetcher: new Fetcher({ fetch: fake, resolve }), seen };
}

describe("fetcher", () => {
  test("fetches a public page as normalised text", async () => {
    const { fetcher } = web({ "https://example.com/t": { body: "<p>Holders:&nbsp;<b>1,200</b></p>" } });
    expect(await fetcher.fetchText("https://example.com/t")).toMatchObject({
      url: "https://example.com/t",
      status: 200,
      text: "Holders: 1,200",
    });
  });

  test("a path robots.txt disallows is never requested", async () => {
    const { fetcher, seen } = web({
      "https://example.com/robots.txt": { body: "User-agent: *\nDisallow: /private/", type: "text/plain" },
      "https://example.com/private/a": { body: "secret" },
      "https://example.com/public": { body: "hello" },
    });
    expect(await reason(fetcher.fetchText("https://example.com/private/a"))).toBe("robots");
    expect(seen).not.toContain("https://example.com/private/a");
    expect((await fetcher.fetchText("https://example.com/public")).text).toBe("hello");
    expect(seen.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(1); // cached per site
  });

  test("when robots.txt errors or is behind a wall, the site is left alone", async () => {
    for (const status of [500, 503, 401, 403, 301]) {
      const { fetcher } = web({
        "https://example.com/robots.txt": { status, location: "https://example.com/elsewhere" },
        "https://example.com/a": { body: "x" },
      });
      expect(await reason(fetcher.fetchText("https://example.com/a"))).toBe("robots");
    }
  });

  test("a redirect to an internal address is refused at the hop, not followed", async () => {
    const { fetcher, seen } = web({
      "https://example.com/go": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
      "https://example.com/go2": { status: 302, location: "http://inside.example/admin" },
    });
    expect(await reason(fetcher.fetchText("https://example.com/go"))).toBe("private_address");
    expect(await reason(fetcher.fetchText("https://example.com/go2"))).toBe("private_address");
    expect(seen.some((u) => u.includes("169.254") || u.includes("inside.example"))).toBe(false);
  });

  test("a public redirect is followed, and robots is checked on the new site too", async () => {
    const { fetcher } = web({
      "https://example.com/go": { status: 301, location: "https://other.example/final" },
      "https://other.example/final": { body: "landed" },
      "https://example.com/blocked": { status: 301, location: "https://strict.example/x" },
      "https://strict.example/robots.txt": { body: "User-agent: *\nDisallow: /", type: "text/plain" },
    });
    expect(await fetcher.fetchText("https://example.com/go")).toMatchObject({ url: "https://other.example/final", text: "landed" });
    expect(await reason(fetcher.fetchText("https://example.com/blocked"))).toBe("robots");
  });

  test("redirect loops stop", async () => {
    const { fetcher } = web({ "https://example.com/loop": { status: 302, location: "https://example.com/loop" } });
    expect(await reason(fetcher.fetchText("https://example.com/loop"))).toBe("redirects");
  });

  test("login walls, errors, binary content and oversized pages are refused", async () => {
    const { fetcher } = web({
      "https://example.com/members": { status: 401 },
      "https://example.com/forbidden": { status: 403 },
      "https://example.com/gone": { status: 500 },
      "https://example.com/file.zip": { body: "PK", type: "application/zip" },
    });
    expect(await reason(fetcher.fetchText("https://example.com/members"))).toBe("login_wall");
    expect(await reason(fetcher.fetchText("https://example.com/forbidden"))).toBe("login_wall");
    expect(await reason(fetcher.fetchText("https://example.com/gone"))).toBe("status");
    expect(await reason(fetcher.fetchText("https://example.com/missing"))).toBe("status");
    expect(await reason(fetcher.fetchText("https://example.com/file.zip"))).toBe("content_type");

    const big = (async (input: URL | string | Request) =>
      input.toString().endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response("x".repeat(5000), { headers: { "content-type": "text/plain" } })) as typeof fetch;
    const small = new Fetcher({ fetch: big, resolve, maxBytes: 1000 });
    expect(await reason(small.fetchText("https://example.com/big"))).toBe("too_large");
  });

  test("a blocked error never carries page content", async () => {
    const { fetcher } = web({ "https://example.com/members": { status: 403, body: "secret account data" } });
    const err = await fetcher.fetchText("https://example.com/members").catch((e) => e);
    expect(err.message).not.toContain("secret");
  });
});
