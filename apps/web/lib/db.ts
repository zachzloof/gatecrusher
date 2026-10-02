import { createDb, type DbHandle } from "@gatecrusher/db";
import { getEnv } from "./env";

declare global {
  var __gatecrusherDb: DbHandle | undefined;
}

/** One pool per process. Kept on globalThis so dev hot reloads do not leak pools. */
export function getDb(): DbHandle {
  globalThis.__gatecrusherDb ??= createDb(getEnv().DATABASE_URL, { max: 5 });
  return globalThis.__gatecrusherDb;
}
