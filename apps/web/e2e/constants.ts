/** Port of its own, so e2e can run while `pnpm dev` is up on 3000. */
export const E2E_PORT = 3100;

/**
 * Points at nothing on purpose: e2e needs no database, the shell must stay usable with
 * Postgres down, and the banner test relies on it. The credentials are markers that
 * the Settings test asserts never reach the page.
 */
export const E2E_DATABASE_URL = "postgres://e2e-user:e2e-secret-password@127.0.0.1:1/e2e";

/** A Redis database no worker writes a heartbeat to. */
export const E2E_REDIS_URL = "redis://127.0.0.1:6379/15";
