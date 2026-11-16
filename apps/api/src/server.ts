import { buildApp } from "./bootstrap";

/**
 * Production entrypoint (day1.md #23). `bun run src/server.ts`, or
 * `bun build` it first — everything is configured through the environment;
 * see bootstrap.ts's header for what each variable does and what it falls
 * back to when unset.
 */
if (import.meta.main) {
  const { app, websocket } = await buildApp();
  const port = Number(process.env.PORT ?? 3000);
  const server = Bun.serve({ port, fetch: app.fetch, websocket });
  console.log(`api listening on :${server.port}`);
}
