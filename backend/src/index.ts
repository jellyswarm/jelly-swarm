import "dotenv/config";
import { app } from "./app";
import { migrate } from "./db/migrate";
import { pool } from "./db";

const port = Number(process.env.PORT ?? 3001);
await migrate();

const server = app.listen(port, () => console.info(`JellySwarm API listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
