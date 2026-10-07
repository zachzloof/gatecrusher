import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";

/** Where the SQL migrations live in the repo. A bundled app passes its own copy's path. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Applies every pending migration. Safe to run repeatedly. */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}
