import { isIP } from "node:net";

/**
 * §13 taint rule: every URL the engine fetches, whoever supplied it, passes
 * this guard. It blocks anything that is not a plain public web page:
 * private and link-local addresses, cloud metadata endpoints, internal
 * hostnames, odd ports, and credentials in the URL.
 */
export type BlockReason =
  | "scheme"
  | "credentials"
  | "port"
  | "blocked_host"
  | "private_address"
  | "dns"
  | "robots"
  | "login_wall"
  | "status"
  | "content_type"
  | "too_large"
  | "redirects"
  | "timeout";

export class FetchBlocked extends Error {
  constructor(
    readonly reason: BlockReason,
    /** Safe to show: never contains response content. */
    detail: string,
  ) {
    super(`fetch blocked (${reason}): ${detail}`);
    this.name = "FetchBlocked";
  }
}

const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** Hostnames that are internal by convention, whatever they resolve to. */
const INTERNAL_HOST = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|svc|cluster)$/i;

function parseV4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function privateV4(b: number[]): boolean {
  const [a, c] = [b[0]!, b[1]!];
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && c >= 64 && c <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && c === 254) || // link-local, cloud metadata
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 0 && b[2] === 0) ||
    (a === 192 && c === 0 && b[2] === 2) || // documentation
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) || // benchmarking
    (a === 198 && c === 51 && b[2] === 100) ||
    (a === 203 && c === 0 && b[2] === 113) ||
    a >= 224 // multicast and reserved
  );
}

/** Expands an IPv6 literal to 8 groups, or null if it is not one. */
function parseV6(ip: string): number[] | null {
  let text = ip.replace(/^\[|\]$/g, "").split("%")[0]!;
  // Embedded IPv4 tail, e.g. ::ffff:10.0.0.1
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseV4(tail[1]!);
    if (!v4) return null;
    const hex = `${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
    text = text.slice(0, -tail[1]!.length) + hex;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const nums = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? Number.parseInt(g, 16) : -1));
  return nums.length === 8 && nums.every((n) => n >= 0) ? nums : null;
}

/** True for any address that is not a public unicast address. Unparseable input counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return privateV4(v4);
  const g = parseV6(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => privateV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // ::
  if (zeros(7) && g[7] === 1) return true; // ::1
  if (zeros(5) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // IPv4-mapped
  if (zeros(6)) return embedded(g[6]!, g[7]!); // IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  const first = g[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && g[1] === 0xdb8) // documentation
  );
}

export type Resolver = (hostname: string) => Promise<string[]>;

export type GuardOptions = {
  resolve: Resolver;
  /** Extra hosts to refuse (exact or parent domain), e.g. known login-walled sites. */
  blockedHosts?: readonly string[];
};

/**
 * Validates one URL before it is fetched: scheme, credentials, port,
 * hostname, and every address the hostname resolves to. Returns the parsed
 * URL. Call it again for each redirect hop.
 *
 * Limit: the address is checked here and resolved again by the HTTP client,
 * so a hostile DNS server could answer differently the second time. Closing
 * that needs connection pinning in the HTTP client, or an egress proxy that
 * enforces the same rules; run the fetcher behind one in production.
 */
export async function assertPublicUrl(raw: string, opts: GuardOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlocked("scheme", "not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchBlocked("scheme", "only http and https are allowed");
  if (url.username || url.password) throw new FetchBlocked("credentials", "URLs with credentials are not allowed");
  if (!ALLOWED_PORTS.has(url.port)) throw new FetchBlocked("port", "only ports 80 and 443 are allowed");

  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "") throw new FetchBlocked("blocked_host", "empty host");
  if (INTERNAL_HOST.test(host)) throw new FetchBlocked("blocked_host", "internal hostname");
  for (const blocked of opts.blockedHosts ?? []) {
    const b = blocked.toLowerCase();
    if (host === b || host.endsWith(`.${b}`)) throw new FetchBlocked("blocked_host", "host is on the block list");
  }

  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new FetchBlocked("private_address", "address is not public");
    return url;
  }
  // A single-label name ("intranet", "db") is never a public site.
  if (!host.includes(".")) throw new FetchBlocked("blocked_host", "single-label hostname");

  let addresses: string[];
  try {
    addresses = await opts.resolve(host);
  } catch {
    throw new FetchBlocked("dns", "hostname did not resolve");
  }
  if (addresses.length === 0) throw new FetchBlocked("dns", "hostname did not resolve");
  // Every address must be public: one private record is enough to refuse.
  if (addresses.some(isPrivateAddress)) throw new FetchBlocked("private_address", "hostname resolves to a non-public address");
  return url;
}
