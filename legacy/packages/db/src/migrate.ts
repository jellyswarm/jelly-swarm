import { fileURLToPath } from "node:url";
import { loadInfraEnv } from "@jelly/shared";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./index";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies every pending migration. */
export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

if (import.meta.main) {
  await runMigrations(loadInfraEnv().DATABASE_URL);
  console.log("migrations applied");
}
