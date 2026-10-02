import { runMigrations } from "../migrate.ts";
import { loadCliEnv } from "./env.ts";

const { env, log } = loadCliEnv("migrate");

try {
  await runMigrations(env.DATABASE_URL);
  log.info("Migrations applied");
} catch (error) {
  log.fatal({ err: error }, "Migration failed. Is Postgres running? Try: docker compose up -d");
  process.exitCode = 1;
}
