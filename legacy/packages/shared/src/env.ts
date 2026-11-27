import { z } from "zod";

const InfraEnv = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});
export type InfraEnv = z.infer<typeof InfraEnv>;

/** Local defaults match docker-compose.yml and .env.example. */
const LOCAL_DEFAULTS: InfraEnv = {
  DATABASE_URL: "postgres://jelly:jelly@localhost:5433/jelly",
  REDIS_URL: "redis://localhost:6380",
};

/**
 * Reads infrastructure settings. Outside production, missing values fall back
 * to the local docker-compose defaults; in production every value is required.
 */
export function loadInfraEnv(env: Record<string, string | undefined> = process.env): InfraEnv {
  const isProd = env.NODE_ENV === "production";
  return InfraEnv.parse({
    DATABASE_URL: env.DATABASE_URL ?? (isProd ? undefined : LOCAL_DEFAULTS.DATABASE_URL),
    REDIS_URL: env.REDIS_URL ?? (isProd ? undefined : LOCAL_DEFAULTS.REDIS_URL),
  });
}
