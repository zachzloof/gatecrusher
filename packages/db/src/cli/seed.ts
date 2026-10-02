import { createDb } from "../client.ts";
import { seed } from "../seed.ts";
import { loadCliEnv } from "./env.ts";

const { env, log } = loadCliEnv("seed");
const handle = createDb(env.DATABASE_URL, { max: 1 });

try {
  const summary = await seed(handle.db);
  log.info(summary, "Seed data written");
} catch (error) {
  log.fatal({ err: error }, "Seeding failed. Has `pnpm db:migrate` been run?");
  process.exitCode = 1;
} finally {
  await handle.close();
}
