import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HttpSwarmApi } from "./api";
import { createMcpServer } from "./server";

/**
 * Streamable HTTP entry point (§9.1). Stateless: each request gets its own
 * server and transport, bound to the access key in that request's
 * Authorization header, so one caller can never act as another.
 */
export function createMcpHandler(opts: { apiUrl: string; fetch?: typeof fetch }) {
  return async (req: Request): Promise<Response> => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    const api = new HttpSwarmApi({
      baseUrl: opts.apiUrl,
      ...(m ? { accessKey: m[1]! } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    // No session id generator: stateless.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createMcpServer(api);
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // Stateless: nothing outlives the request.
      void server.close().catch(() => {});
    }
  };
}

if (import.meta.main) {
  const apiUrl = process.env.JELLY_API_URL;
  if (!apiUrl) {
    console.error("JELLY_API_URL is not set");
    process.exit(1);
  }
  const handler = createMcpHandler({ apiUrl });
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8787),
    fetch: (req) => (new URL(req.url).pathname === "/mcp" ? handler(req) : new Response("not found", { status: 404 })),
  });
  console.error(`MCP listening on :${server.port}/mcp`);
}
