import { lookup } from "node:dns/promises";
import { FetchBlocked, type Resolver, assertPublicUrl } from "./guard";
import { type RobotsRules, isAllowed, parseRobots } from "./robots";
import { htmlToText, normalizeText } from "./text";

export type FetchedPage = {
  /** The URL the content came from, after redirects. */
  url: string;
  status: number;
  contentType: string;
  /** Normalised visible text. */
  text: string;
};

/** What the checker and the worker tools need from a fetcher; easy to fake in tests. */
export interface PageFetcher {
  fetchText(url: string): Promise<FetchedPage>;
}

export type FetcherOptions = {
  fetch?: typeof fetch;
  resolve?: Resolver;
  /** Sent as User-Agent and matched against robots.txt groups. */
  userAgent?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  blockedHosts?: readonly string[];
  robotsTtlMs?: number;
  now?: () => number;
};

const TEXT_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml|application\/json)\b/i;

const systemResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * The one way the engine reads the public web. Every request, including each
 * redirect hop and robots.txt itself, passes the SSRF guard; robots.txt is
 * honoured; login-walled pages are refused, never worked around.
 */
export class Fetcher implements PageFetcher {
  private readonly robots = new Map<string, { rules: RobotsRules | "deny"; at: number }>();
  private readonly doFetch: typeof fetch;
  private readonly agent: string;
  private readonly now: () => number;

  constructor(private readonly opts: FetcherOptions = {}) {
    this.doFetch = opts.fetch ?? fetch;
    this.agent = opts.userAgent ?? "JellySwarmBot/1.0";
    this.now = opts.now ?? Date.now;
  }

  private guard(url: string): Promise<URL> {
    return assertPublicUrl(url, {
      resolve: this.opts.resolve ?? systemResolve,
      ...(this.opts.blockedHosts ? { blockedHosts: this.opts.blockedHosts } : {}),
    });
  }

  private async request(url: URL): Promise<Response> {
    try {
      return await this.doFetch(url, {
        redirect: "manual",
        headers: { "user-agent": this.agent, accept: "text/html,text/plain,application/json;q=0.8" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new FetchBlocked(timedOut ? "timeout" : "status", timedOut ? "request timed out" : "request failed");
    }
  }

  private async readBody(res: Response): Promise<string> {
    const max = this.opts.maxBytes ?? 2_000_000;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > max) throw new FetchBlocked("too_large", "response is larger than the size limit");
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new FetchBlocked("too_large", "response is larger than the size limit");
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  }

  private async rulesFor(url: URL): Promise<RobotsRules | "deny"> {
    const cached = this.robots.get(url.origin);
    if (cached && this.now() - cached.at < (this.opts.robotsTtlMs ?? 3_600_000)) return cached.rules;

    let rules: RobotsRules | "deny";
    try {
      const res = await this.request(await this.guard(`${url.origin}/robots.txt`));
      if (res.status >= 200 && res.status < 300) rules = parseRobots(await this.readBody(res), this.agent);
      // No robots.txt: nothing is disallowed. A redirect, an auth wall or a
      // server error: we cannot tell what the site allows, so we stay out.
      else if (res.status === 404 || res.status === 410) rules = { allow: [], disallow: [] };
      else rules = "deny";
    } catch {
      rules = "deny";
    }
    this.robots.set(url.origin, { rules, at: this.now() });
    return rules;
  }

  async fetchText(raw: string): Promise<FetchedPage> {
    let next = raw;
    for (let hop = 0; hop <= (this.opts.maxRedirects ?? 5); hop++) {
      const url = await this.guard(next);
      const rules = await this.rulesFor(url);
      if (rules === "deny" || !isAllowed(rules, url.pathname + url.search)) {
        throw new FetchBlocked("robots", "robots.txt does not allow this path");
      }

      const res = await this.request(url);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new FetchBlocked("status", `redirect without a location (HTTP ${res.status})`);
        next = new URL(location, url).toString();
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 407) {
        throw new FetchBlocked("login_wall", `page requires sign-in (HTTP ${res.status})`);
      }
      if (res.status < 200 || res.status >= 300) throw new FetchBlocked("status", `HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") ?? "";
      if (!TEXT_TYPES.test(contentType)) throw new FetchBlocked("content_type", "not a text page");
      const body = await this.readBody(res);
      const text = /html|xhtml/i.test(contentType) ? htmlToText(body) : normalizeText(body);
      return { url: url.toString(), status: res.status, contentType, text };
    }
    throw new FetchBlocked("redirects", "too many redirects");
  }
}
