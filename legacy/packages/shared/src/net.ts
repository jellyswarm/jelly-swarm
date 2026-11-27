import { isIPv4, isIPv6 } from "node:net";

/**
 * §10.3 "shared IP prefix": never the full address, just enough to bucket likely-same-network
 * callers — /24 for IPv4, /48 for IPv6 (same convention as the `free_grants` table's own
 * `ipPrefix` column). An address that parses as neither is returned as-is, its own one-member
 * bucket, rather than thrown away.
 */
export function ipPrefixOf(ip: string): string {
  if (isIPv4(ip)) {
    const [a, b, c] = ip.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIPv6(ip)) {
    const groups = expandIpv6(ip);
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return ip;
}

/** Fills in a `::` run with however many all-zero groups it elides, so every address has 8 groups. */
function expandIpv6(ip: string): string[] {
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  if (!ip.includes("::")) return headParts;
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  return [...headParts, ...Array(missing).fill("0"), ...tailParts];
}
