import type { HealthResponse } from "./api-schemas";

export interface SystemProblem {
  message: string;
  /** The command that fixes it, when there is one. */
  command?: string;
}

/**
 * What the banner should say for a health result, most fundamental problem first.
 * `null` health means the web server itself did not answer; a `null` result means
 * everything is up and no banner is shown.
 */
export function describeProblem(health: HealthResponse | null): SystemProblem | null {
  if (health === null) {
    return { message: "Can't reach the Gatecrusher server. Retrying…" };
  }

  const down = [...(health.db.ok ? [] : ["Postgres"]), ...(health.redis.ok ? [] : ["Redis"])];
  if (down.length > 0) {
    return {
      message: `${down.join(" and ")} unreachable. Start the services:`,
      command: "docker compose up -d",
    };
  }

  if (!health.worker.online) {
    return {
      message: "Worker offline. Nothing will download until it is started:",
      command: "pnpm --filter @gatecrusher/worker dev",
    };
  }

  return null;
}
