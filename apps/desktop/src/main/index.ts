// The desktop app's main process. On start it checks this build may run (access code,
// expiry), then starts the app's private Postgres, applies migrations, and runs the web
// server and the worker as child processes; the window shows the local web app. On quit
// it stops all of them.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "@gatecrusher/db/migrate";
import { app, ipcMain, session, shell, type BrowserWindow } from "electron";
import {
  acceptCode,
  accessStatus,
  effectiveNow,
  findCodeByHash,
  type AccessStatus,
} from "./access.ts";
import { ACCESS_CODES, OWNER_CONTACT } from "./build-config.ts";
import { downloadsFolderSchema, submittedCodeSchema, type GateState } from "./gate-state.ts";
import { IPC } from "./ipc.ts";
import { createMainLog, type MainLog } from "./log.ts";
import { installMenu } from "./menu.ts";
import { resolvePaths, type AppPaths } from "./paths.ts";
import { freePort } from "./ports.ts";
import { databaseExists, startPostgres, type RunningPostgres } from "./postgres.ts";
import { startService, waitForWeb, type RunningService, type ServiceSpec } from "./services.ts";
import { loadStore, saveStore, type DesktopStore } from "./store.ts";
import { createGateWindow, createMainWindow, type GateWindow } from "./windows.ts";
import { prepareYtDlp, updateYtDlpInBackground } from "./yt-dlp.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const GATE_HTML = path.join(here, "renderer", "gate.html");
const GATE_PRELOAD = path.join(here, "preload-gate.cjs");
const APP_PRELOAD = path.join(here, "preload-app.cjs");

/** Kept when free, so the app's address (and what the browser stores for it) stays put. */
const PREFERRED_WEB_PORT = 47_321;
const ACCESS_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 3_000;

interface Running {
  postgres?: RunningPostgres;
  web?: RunningService;
  worker?: RunningService;
}

let paths: AppPaths | undefined;
let log: MainLog | undefined;
let gate: GateWindow | null = null;
let mainWindow: BrowserWindow | null = null;
const running: Running = {};
let stopping: Promise<void> | null = null;
let stopped = false;
let codeEntered: ((acceptedCodeHash: string) => void) | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showGate(state: GateState): void {
  if (gate === null || gate.window.isDestroyed()) {
    gate = createGateWindow({ html: GATE_HTML, preload: GATE_PRELOAD, initial: state });
    gate.window.on("closed", () => {
      gate = null;
    });
  } else {
    gate.show(state);
  }
}

function closeGate(): void {
  if (gate !== null && !gate.window.isDestroyed()) gate.window.close();
  gate = null;
}

/** The code screen, after the code this machine entered has reached its end date. */
function expiredState(expiredAt: string): GateState {
  return { mode: "code", contact: OWNER_CONTACT, expiredAt };
}

/** One line about this build for the Help menu: the end date of the code in use, if any. */
function aboutLine(store: DesktopStore): string {
  const code = findCodeByHash(store.acceptedCodeHash, ACCESS_CODES);
  const until =
    code?.expiresAt == null ? "" : `, test build until ${code.expiresAt.slice(0, 10)}`;
  return `Gatecrusher ${app.getVersion()}${until}`;
}

/** Shows the code screen and waits until a code this build accepts is entered. */
async function askForCode(state: GateState): Promise<string> {
  showGate(state);
  const acceptedCodeHash = await new Promise<string>((resolve) => {
    codeEntered = resolve;
  });
  codeEntered = null;
  return acceptedCodeHash;
}

/** Child processes get the user's environment plus ours; our tools come first on PATH. */
function childEnv(
  extra: Record<string, string>,
  pathDirs: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Windows spells it "Path"; adding "PATH" next to it would leave two.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [...pathDirs, env[pathKey] ?? ""].filter((dir) => dir !== "").join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

/** Restarts a service that dies on its own, a few times, then leaves it down. */
function supervise(spec: ServiceSpec, mainLog: MainLog): RunningService {
  let restarts = 0;
  let stopRequested = false;
  const launch = (): RunningService => startService(spec, mainLog, onUnexpectedExit);
  let current = launch();

  function onUnexpectedExit(): void {
    if (stopRequested || restarts >= MAX_RESTARTS) return;
    restarts += 1;
    mainLog.warn(`Restarting ${spec.name}`, { attempt: restarts });
    setTimeout(() => {
      if (!stopRequested) current = launch();
    }, RESTART_DELAY_MS);
  }

  return {
    exited: () => current.exited(),
    stop: async () => {
      stopRequested = true;
      await current.stop();
    },
  };
}

async function startServices(
  appPaths: AppPaths,
  store: DesktopStore,
  mainLog: MainLog,
  step: (text: string) => void,
): Promise<string> {
  step("Starting the database…");
  running.postgres = await startPostgres({
    installDir: appPaths.postgresDir,
    dataDir: appPaths.databaseDir,
    logFile: path.join(appPaths.logsDir, "postgres.log"),
    password: store.dbPassword,
    port: await freePort(),
    platform: process.platform,
  });
  mainLog.info("Postgres started");

  step("Updating the database…");
  await runMigrations(running.postgres.url, appPaths.migrationsDir);

  step("Starting Gatecrusher…");
  const ytDlp = await prepareYtDlp({
    shippedBinDir: appPaths.binDir,
    toolsDir: appPaths.toolsDir,
    platform: process.platform,
  });
  updateYtDlpInBackground(ytDlp, mainLog);

  await mkdir(appPaths.downloadsDir, { recursive: true });
  const webPort = await freePort(PREFERRED_WEB_PORT);
  const url = `http://127.0.0.1:${webPort}`;
  const shared = {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    DATABASE_URL: running.postgres.url,
    DATA_DIR: appPaths.dataDir,
    YT_DLP_PATH: ytDlp,
  };
  // yt-dlp finds ffmpeg and ffprobe on PATH.
  const pathDirs = [appPaths.binDir];

  running.web = supervise(
    {
      name: "web",
      graceful: false,
      modulePath: appPaths.webServer,
      cwd: path.dirname(appPaths.webServer),
      env: childEnv(
        { ...shared, PORT: String(webPort), HOSTNAME: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1" },
        pathDirs,
      ),
    },
    mainLog,
  );
  running.worker = supervise(
    {
      name: "worker",
      graceful: true,
      modulePath: appPaths.workerEntry,
      cwd: path.dirname(appPaths.workerEntry),
      env: childEnv({ ...shared, NATIVE_DOWNLOAD_MODE: "yt-dlp" }, pathDirs),
    },
    mainLog,
  );

  await waitForWeb(url, running.web);
  mainLog.info("Web is answering", { port: webPort });
  return url;
}

/** Stops everything that was started, last started first. Never rejects. */
async function stopServices(): Promise<void> {
  const steps: [string, { stop(): Promise<void> } | undefined][] = [
    ["worker", running.worker],
    ["web", running.web],
    ["postgres", running.postgres],
  ];
  delete running.worker;
  delete running.web;
  delete running.postgres;
  for (const [name, service] of steps) {
    try {
      await service?.stop();
    } catch (error) {
      log?.error(`Could not stop ${name}`, { err: error });
    }
  }
}

/** Checks the build may still run, and moves the "latest time seen" forward. */
async function checkAccess(
  store: DesktopStore,
): Promise<{ store: DesktopStore; status: AccessStatus }> {
  const now = new Date();
  const status = accessStatus({
    now,
    lastSeenAt: store.lastSeenAt,
    acceptedCodeHash: store.acceptedCodeHash,
    codes: ACCESS_CODES,
  });
  const next = { ...store, lastSeenAt: effectiveNow(now, store.lastSeenAt).toISOString() };
  if (paths !== undefined) await saveStore(paths.root, next);
  return { store: next, status };
}

async function openDownloads(folder: string | undefined): Promise<void> {
  if (paths === undefined) return;
  const target = folder === undefined ? paths.downloadsDir : path.join(paths.downloadsDir, folder);
  await mkdir(target, { recursive: true });
  const failed = await shell.openPath(target);
  if (failed !== "") log?.warn("Could not open the downloads folder", { reason: failed });
}

function registerIpc(): void {
  // The gate channels answer the gate window only; the app window has its own bridge.
  const fromGate = (sender: Electron.WebContents): boolean =>
    gate !== null && !gate.window.isDestroyed() && sender === gate.window.webContents;
  ipcMain.handle(IPC.gateGetState, (event) => (fromGate(event.sender) ? gate?.current() : null));
  ipcMain.handle(IPC.gateSubmitCode, (event, raw: unknown) => {
    if (!fromGate(event.sender)) return false;
    const typed = submittedCodeSchema.safeParse(raw);
    const code = typed.success ? acceptCode(typed.data, ACCESS_CODES, new Date()) : null;
    if (code === null) {
      log?.warn("A wrong or expired access code was entered");
      return false;
    }
    codeEntered?.(code.sha256);
    return true;
  });
  ipcMain.on(IPC.gateOpenLogs, (event) => {
    if (fromGate(event.sender) && paths !== undefined) void shell.openPath(paths.logsDir);
  });
  ipcMain.on(IPC.gateQuit, (event) => {
    if (fromGate(event.sender)) app.quit();
  });
  ipcMain.handle(IPC.openDownloads, async (event, raw: unknown) => {
    // Only the app window may ask, and only for a folder name inside downloads/.
    if (mainWindow === null || event.sender !== mainWindow.webContents) return;
    const folder = raw === undefined ? undefined : downloadsFolderSchema.safeParse(raw);
    if (folder !== undefined && !folder.success) return;
    await openDownloads(folder?.data);
  });
}

async function boot(): Promise<void> {
  const appPaths = resolvePaths({
    resourcesDir: app.isPackaged ? process.resourcesPath : path.resolve(here, "..", "stage"),
    platform: process.platform,
    userDataDir: app.getPath("userData"),
    localAppDataDir: process.env.LOCALAPPDATA,
    packaged: app.isPackaged,
    rootOverride: process.env.GATECRUSHER_ROOT,
  });
  paths = appPaths;
  await mkdir(appPaths.root, { recursive: true });
  const mainLog = createMainLog(appPaths.logsDir);
  log = mainLog;
  mainLog.info("Starting", {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  });

  // The app asks for nothing: no camera, notifications, location or anything else.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, decide) =>
    decide(false),
  );

  const checked = await checkAccess(
    await loadStore(appPaths.root, { databaseExists: await databaseExists(appPaths.databaseDir) }),
  );
  const { status } = checked;
  let { store } = checked;
  // Installed again after a code is entered, so the Help menu names that code's end date.
  const menu = (): void =>
    installMenu(
      {
        openDownloads: () => void openDownloads(undefined),
        openLogs: () => void shell.openPath(appPaths.logsDir),
        about: aboutLine(store),
      },
      process.platform,
    );
  menu();
  if (status.kind !== "ok") {
    if (status.kind === "expired") mainLog.info("The access code in use has expired");
    const acceptedCodeHash = await askForCode(
      status.kind === "expired"
        ? expiredState(status.expiredAt)
        : { mode: "code", contact: OWNER_CONTACT },
    );
    store = { ...store, acceptedCodeHash };
    await saveStore(appPaths.root, store);
    mainLog.info("Access code accepted");
    menu();
  }

  showGate({ mode: "starting", step: "Starting…" });
  const url = await startServices(appPaths, store, mainLog, (step) =>
    showGate({ mode: "starting", step }),
  );

  const window = createMainWindow({ url, preload: APP_PRELOAD });
  mainWindow = window;
  window.once("ready-to-show", () => {
    window.show();
    closeGate();
  });
  window.on("closed", () => {
    mainWindow = null;
  });

  // A copy left open past its code's end date stops too and asks for a new code; once
  // one is entered the app starts over.
  const timer = setInterval(() => {
    void checkAccess(store).then(async (checked) => {
      store = checked.store;
      if (checked.status.kind !== "expired") return;
      clearInterval(timer);
      mainLog.info("The access code in use expired while running");
      const asking = askForCode(expiredState(checked.status.expiredAt));
      mainWindow?.close();
      await stopServices();
      const acceptedCodeHash = await asking;
      await saveStore(appPaths.root, { ...store, acceptedCodeHash });
      mainLog.info("Access code accepted; restarting");
      app.relaunch();
      app.quit();
    });
  }, ACCESS_CHECK_INTERVAL_MS);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow ?? gate?.window;
    if (window === undefined || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    stopping ??= stopServices().finally(() => {
      stopped = true;
      log?.info("Stopped");
      app.quit();
    });
  });

  registerIpc();
  void app.whenReady().then(() =>
    boot().catch((error: unknown) => {
      log?.error("Could not start", { err: error });
      void stopServices();
      showGate({ mode: "error", message: errorMessage(error) });
    }),
  );
}
