import path from "node:path";

/**
 * Where everything is. Read-only parts ship with the app (the installer's resources, or
 * `stage/` when running from the repo, laid out the same way). Writable parts live in a
 * per-user folder that is never synced: %LOCALAPPDATA%\Gatecrusher on Windows, the app's
 * Application Support folder on macOS.
 */
export interface AppPaths {
  /** The Next.js standalone server. */
  webServer: string;
  /** The bundled worker. */
  workerEntry: string;
  /** ffmpeg, ffprobe and the yt-dlp shipped with this version. */
  binDir: string;
  /** Postgres: bin/, lib/, share/. */
  postgresDir: string;
  migrationsDir: string;

  /** The per-user folder everything below lives in. */
  root: string;
  /** DATA_DIR for web and worker: downloads, and yt-dlp's short-lived cookie files. */
  dataDir: string;
  downloadsDir: string;
  databaseDir: string;
  logsDir: string;
  /** The yt-dlp that is run: a copy of the shipped one that keeps itself up to date. */
  toolsDir: string;
}

export interface PathInputs {
  /** `process.resourcesPath` when packaged, the repo's `apps/desktop/stage` otherwise. */
  resourcesDir: string;
  platform: NodeJS.Platform;
  /** Electron's `userData` folder. */
  userDataDir: string;
  /** %LOCALAPPDATA% on Windows. */
  localAppDataDir: string | undefined;
  packaged: boolean;
  /** GATECRUSHER_ROOT: a throwaway folder for the smoke test. Ignored when packaged. */
  rootOverride?: string | undefined;
}

export function resolvePaths(inputs: PathInputs): AppPaths {
  const resources = inputs.resourcesDir;
  const base =
    inputs.platform === "win32" && inputs.localAppDataDir !== undefined
      ? path.join(inputs.localAppDataDir, "Gatecrusher")
      : inputs.userDataDir;
  // A copy run from the repo never touches an installed copy's data.
  const devRoot = inputs.rootOverride ?? `${base}-dev`;
  const root = inputs.packaged ? base : devRoot;
  const dataDir = path.join(root, "data");

  return {
    webServer: path.join(resources, "web", "apps", "web", "server.js"),
    workerEntry: path.join(resources, "worker", "worker.mjs"),
    binDir: path.join(resources, "bin"),
    postgresDir: path.join(resources, "postgres"),
    migrationsDir: path.join(resources, "migrations"),
    root,
    dataDir,
    downloadsDir: path.join(dataDir, "downloads"),
    databaseDir: path.join(root, "postgres"),
    logsDir: path.join(root, "logs"),
    toolsDir: path.join(root, "bin"),
  };
}

export function executable(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}
