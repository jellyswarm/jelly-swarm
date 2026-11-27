import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpSwarmApi } from "./api";
import { createMcpServer } from "./server";

/**
 * stdio entry point: `bun apps/mcp/src/stdio.ts`.
 *   JELLY_API_URL     base URL of the JellySwarm API (required)
 *   JELLY_ACCESS_KEY  the caller's access key (optional; a quote issues one if absent)
 * Nothing is written to stdout except protocol messages.
 */
const baseUrl = process.env.JELLY_API_URL;
if (!baseUrl) {
  console.error("JELLY_API_URL is not set");
  process.exit(1);
}
const api = new HttpSwarmApi({ baseUrl, ...(process.env.JELLY_ACCESS_KEY ? { accessKey: process.env.JELLY_ACCESS_KEY } : {}) });
await createMcpServer(api).connect(new StdioServerTransport());
