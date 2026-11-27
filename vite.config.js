import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendEnv = loadEnv(mode, `${process.cwd()}/backend`, "");
  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: env.JELLYSWARM_API_URL || "http://localhost:3001",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (backendEnv.MASTER_API_KEY) proxyReq.setHeader("x-api-key", backendEnv.MASTER_API_KEY);
            });
          },
        },
      },
    },
  };
});
