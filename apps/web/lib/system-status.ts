import type { HealthResponse } from "./api-schemas";

export interface SystemProblem {
  message: string;
  /** The command that fixes it, when there is one. */
  command?: string;
}

/**
 * What the banner should say for a health result, most fundamental problem first.
 * `null` health means the web server itself did not answer; a `null` result means
 * everything is up and no banner is shown. Inside the desktop app the app runs every
 * service itself, so there is no command to give: restarting the app is the fix.
 */
export function describeProblem(
  health: HealthResponse | null,
  options: { desktop?: boolean } = {},
): SystemProblem | null {
  if (health === null) {
    return { message: "Can't reach the Gatecrusher server. Retrying…" };
  }

  if (!health.db.ok) {
    if (options.desktop === true) {
      return { message: "The database stopped. Quit Gatecrusher and open it again." };
    }
    return { message: "Postgres unreachable. Start it:", command: "docker compose up -d" };
  }

  if (!health.worker.online) {
    if (options.desktop === true) {
      return {
        message:
          "The downloader is starting or stopped. If this stays, quit Gatecrusher and open it again.",
      };
    }
    return {
      message: "Worker offline. Nothing will download until it is started:",
      command: "pnpm --filter @gatecrusher/worker dev",
    };
  }

  return null;
}
