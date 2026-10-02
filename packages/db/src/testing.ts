import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, type DbHandle } from "./client.ts";
import { runMigrations } from "./migrate.ts";

const DEFAULT_SERVER_URL = "postgres://gatecrusher:gatecrusher@localhost:5432/gatecrusher";

/** The same server and credentials, pointed at a different database. */
function urlForDatabase(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function runAsAdmin(serverUrl: string, statement: string): Promise<void> {
  const admin = postgres(urlForDatabase(serverUrl, "postgres"), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

export interface TestDatabase {
  url: string;
  handle: DbHandle;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

/**
 * For integration tests only: a brand-new database on the development server, so tests
 * never touch development data. Migrated unless `migrate: false`.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const serverUrl = process.env.DATABASE_URL ?? DEFAULT_SERVER_URL;
  // Generated here from hex only, which is why it is safe to interpolate as an identifier.
  const name = `gatecrusher_test_${randomBytes(6).toString("hex")}`;
  const url = urlForDatabase(serverUrl, name);

  await runAsAdmin(serverUrl, `create database "${name}"`);
  if (options.migrate !== false) await runMigrations(url);
  const handle = createDb(url, { max: 2 });

  return {
    url,
    handle,
    drop: async () => {
      await handle.close();
      await runAsAdmin(serverUrl, `drop database if exists "${name}" with (force)`);
    },
  };
}
