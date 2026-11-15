/**
 * What the MCP server needs from the JellySwarm API. The MCP app holds no
 * engine and no keys of its own: every tool is a call to the REST API on
 * behalf of the caller's access key.
 */
export type ApiResult = { ok: true; status: number; data: unknown } | { ok: false; status: number; message: string; data?: unknown };

export interface SwarmApi {
  quote(input: Record<string, unknown>): Promise<ApiResult>;
  runFromVault(quoteId: string, grant?: unknown): Promise<ApiResult>;
  runX402(quoteId: string, payer: string): Promise<ApiResult>;
  status(jobKey: string, sinceSeq?: number): Promise<ApiResult>;
  result(jobKey: string, format: "json" | "csv" | "md"): Promise<ApiResult>;
  transcript(jobKey: string, rowIdx?: number): Promise<ApiResult>;
  dispute(jobKey: string, rowIdx: number[], evidence: string): Promise<ApiResult>;
}

export type HttpSwarmApiOptions = {
  baseUrl: string;
  /** The caller's access key. Without one, a quote returns a fresh key that is then used for the session. */
  accessKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class HttpSwarmApi implements SwarmApi {
  private accessKey: string | undefined;

  constructor(private readonly opts: HttpSwarmApiOptions) {
    this.accessKey = opts.accessKey;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.accessKey ? { authorization: `Bearer ${this.accessKey}` } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch {
      return { ok: false, status: 0, message: "The JellySwarm API could not be reached." };
    }
    const data: unknown = await res.json().catch(() => null);
    if (res.ok) return { ok: true, status: res.status, data };
    const message = data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
    return { ok: false, status: res.status, message, data };
  }

  async quote(input: Record<string, unknown>): Promise<ApiResult> {
    const r = await this.call("POST", "/v1/quotes", input);
    // First quote without a key: keep the key the API issued, and never pass it on to the model.
    if (r.ok && r.data && typeof r.data === "object" && "accessKey" in r.data) {
      const { accessKey, accessKeyNote: _note, ...rest } = r.data as Record<string, unknown>;
      if (typeof accessKey === "string") this.accessKey = accessKey;
      return { ...r, data: rest };
    }
    return r;
  }

  runFromVault(quoteId: string, grant?: unknown): Promise<ApiResult> {
    return this.call("POST", "/v1/jobs", { quoteId, route: "vault", ...(grant ? { grant } : {}) });
  }

  runX402(quoteId: string, payer: string): Promise<ApiResult> {
    return this.call("POST", "/v1/x402/jobs", { quoteId }, { "x-jelly-payer": payer });
  }

  status(jobKey: string, sinceSeq?: number): Promise<ApiResult> {
    return this.call("GET", `/v1/jobs/${jobKey}${sinceSeq ? `?sinceSeq=${sinceSeq}` : ""}`);
  }

  result(jobKey: string, format: "json" | "csv" | "md"): Promise<ApiResult> {
    return this.call("GET", `/v1/jobs/${jobKey}/result?format=${format}`);
  }

  transcript(jobKey: string, rowIdx?: number): Promise<ApiResult> {
    return this.call("GET", `/v1/jobs/${jobKey}/transcript${rowIdx === undefined ? "" : `?row=${rowIdx}`}`);
  }

  dispute(jobKey: string, rowIdx: number[], evidence: string): Promise<ApiResult> {
    return this.call("POST", `/v1/jobs/${jobKey}/disputes`, { rowIdx, evidence });
  }
}
