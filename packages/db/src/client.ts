import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export interface CreateDbOptions {
  /** Maximum pool size. */
  max?: number;
}

export function createDb(url: string, options: CreateDbOptions = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: 5,
    // Postgres NOTICEs (e.g. "relation already exists, skipping") are not errors.
    onnotice: () => undefined,
  });
  const db = drizzle(client, { schema });

  return {
    db,
    /** Round-trips a trivial query; rejects when Postgres is unreachable. */
    ping: async (): Promise<void> => {
      await client`select 1`;
    },
    close: (): Promise<void> => client.end({ timeout: 5 }),
  };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Database = DbHandle["db"];
