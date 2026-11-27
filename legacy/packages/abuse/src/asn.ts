/** §10.3 "10 / 24h per datacenter ASN": which network an address belongs to. */
export interface AsnLookup {
  /** The ASN for `ip`, or undefined if it could not be resolved (never throws). */
  lookup(ip: string): Promise<number | undefined>;
}

/**
 * RIPEstat's network-info endpoint (stat.ripe.net): free, public, no API key, and answers for
 * any address — not just RIPE's own region, despite the name. Fails open (undefined) on any
 * network error or malformed response, same as a missing ASN already behaves in `checkAndConsume`:
 * that bucket is simply skipped, never the caller's fault.
 */
export class RipeAsnLookup implements AsnLookup {
  constructor(private readonly opts: { fetch?: typeof fetch; timeoutMs?: number } = {}) {}

  async lookup(ip: string): Promise<number | undefined> {
    try {
      const res = await (this.opts.fetch ?? fetch)(`https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(ip)}`, {
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2000),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data?: { asns?: ReadonlyArray<string | number> } };
      const asn = body.data?.asns?.[0];
      if (asn === undefined) return undefined;
      const n = Number(asn);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  }
}
