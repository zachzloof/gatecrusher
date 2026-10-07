// The worker as the desktop app runs it: an Electron utility process. Bundled to
// stage/worker/worker.mjs with Playwright replaced by a stub (src/shims/playwright.ts):
// the desktop app never drives a browser.
import {
  createLogger,
  killRunningProcesses,
  loadEnv,
  removeStaleCookieFiles,
  resolveDataDir,
  startWorker,
} from "@gatecrusher/worker/embed";

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);

if (env.NATIVE_DOWNLOAD_MODE !== "yt-dlp") {
  log.fatal("The desktop app only downloads with yt-dlp");
  process.exit(1);
}

const started = await startWorker({ env, log });
if (!started.ok) {
  log.fatal({ kind: started.kind }, started.reason);
  process.exit(1);
}

let stopping = false;

/**
 * The app is quitting: stop at once. A download in progress is killed and its job stays
 * RUNNING, so the next start runs it again from the beginning. The login cookie file of
 * that download is removed now rather than at the next start.
 */
async function stopNow(): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("Stopping: the app is quitting");
  killRunningProcesses();
  await removeStaleCookieFiles(resolveDataDir(env.DATA_DIR)).catch((error: unknown) =>
    log.error({ err: error }, "Could not remove login cookie files"),
  );
  process.exit(0);
}

process.parentPort.on("message", (event) => {
  if (event.data === "shutdown") void stopNow();
});
