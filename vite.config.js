import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { forward } from "./api/_proxy.js";

/**
 * Local /api proxy. It uses the same rules as the Vercel function (api/proxy.js):
 * only the allowlisted job routes, with MASTER_API_KEY added here on the server.
 * The browser never sees the key and never calls the backend directly, so no CORS.
 */
function apiProxy(env) {
  return {
    name: "jellyswarm-api-proxy",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        let body;
        if (req.method !== "GET" && req.method !== "HEAD") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          } catch {
            body = {};
          }
        }
        // Connect strips the "/api" mount path from req.url; put it back for the shared rules.
        const result = await forward({ method: req.method, url: `/api${req.url}`, body, env, cookie: req.headers.cookie });
        res.statusCode = result.status;
        res.setHeader("content-type", result.contentType);
        res.setHeader("cache-control", "no-store");
        if (result.paymentRequired) res.setHeader("PAYMENT-REQUIRED", result.paymentRequired);
        if (result.setCookie) res.setHeader("Set-Cookie", result.setCookie);
        if (result.requestId) res.setHeader("x-request-id", result.requestId);
        res.end(result.body);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load every variable (not only VITE_*) for the server-side proxy. None of these reach the bundle:
  // only VITE_* variables are exposed to client code, and the key is deliberately not one of them.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), apiProxy(env)],
    server: { port: 5173, host: "0.0.0.0" },
    // The lazy app chunk (RainbowKit + wagmi) is ~620 kB before gzip; wallet SDKs still split further.
    build: { chunkSizeWarningLimit: 700 },
  };
});
