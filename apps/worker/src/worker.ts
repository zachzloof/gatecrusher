import { WORKER_POLL_INTERVAL_MS, type WorkerEnv } from "@gatecrusher/core";
import {
  createDb,
  getJobContext,
  interruptedJobIds,
  markJobFailed,
  nextQueuedJobId,
  refreshRun,
} from "@gatecrusher/db";
import {
  createDelayProvider,
  registry as defaultRegistry,
  type AdapterRegistry,
  type BrowserGateAdapter,
  type DelayProvider,
} from "@gatecrusher/gates";
import type { Logger } from "pino";
import {
  createBrowserSession,
  launchHeadedBrowser,
  type BrowserLauncher,
  type BrowserSession,
} from "./browser.ts";
import { removeStaleCookieFiles } from "./cookie-file.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { startJobLoop, type TrackOutcome } from "./job-loop.ts";
import { createParkedPages } from "./parked-pages.ts";
import { browserProfileDir, resolveDataDir } from "./paths.ts";
import { execFileRunner, type ProcessRunner } from "./process-runner.ts";
import { processTrackJob, type TrackJobDeps } from "./track-job.ts";
import { processYtDlpJob } from "./ytdlp-job.ts";

export interface StartWorkerOptions {
  env: WorkerEnv;
  log: Logger;
  /** How long an idle worker waits before looking for queued jobs again. */
  pollIntervalMs?: number;
  /**
   * Test seams. The real worker always uses the headed launcher, the randomised delay
   * provider, the built-in registry and real yt-dlp; tests swap in a headless browser
   * on a throwaway profile, zero delays, an adapter pointed at local fixtures, and a
   * fake yt-dlp that writes a file.
   */
  launchBrowser?: BrowserLauncher;
  runner?: ProcessRunner;
  delay?: DelayProvider;
  registry?: AdapterRegistry<BrowserGateAdapter>;
  landmarkTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

export interface RunningWorker {
  /** Stops taking jobs, lets the current one finish, then releases every connection. */
  close(): Promise<void>;
}

export type StartWorkerResult =
  { ok: true; worker: RunningWorker } | { ok: false; kind: "postgres_unreachable"; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startWorker(options: StartWorkerOptions): Promise<StartWorkerResult> {
  const { env, log } = options;

  const db = createDb(env.DATABASE_URL, { max: 5 });
  try {
    await db.ping();
  } catch (error) {
    await db.close();
    return {
      ok: false,
      kind: "postgres_unreachable",
      reason: `Cannot reach Postgres at DATABASE_URL (${errorMessage(error)}). Is \`docker compose up -d\` running?`,
    };
  }
  log.info("Connected to Postgres");

  const dataDir = resolveDataDir(env.DATA_DIR);
  const delay = options.delay ?? createDelayProvider();

  // Native downloads go through yt-dlp unless the paused browser path is chosen on
  // purpose (NATIVE_DOWNLOAD_MODE=browser, see docs/PIVOT.md). In yt-dlp mode no browser
  // session exists, so none can open by accident.
  let browser: BrowserSession | undefined;
  let processTrack: (jobId: string) => Promise<TrackOutcome>;
  if (env.NATIVE_DOWNLOAD_MODE === "browser") {
    // The browser opens with the first browser job, not here: a worker with nothing to
    // do does not put a window on the screen.
    browser = createBrowserSession({
      profileDir: browserProfileDir(dataDir),
      launch: options.launchBrowser ?? launchHeadedBrowser,
      log,
    });
    const trackDeps: TrackJobDeps = {
      db: db.db,
      log,
      browser,
      parked: createParkedPages(),
      registry: options.registry ?? defaultRegistry,
      delay,
      dataDir,
      minDownloadBytes: env.MIN_DOWNLOAD_BYTES,
      ...(options.landmarkTimeoutMs === undefined
        ? {}
        : { landmarkTimeoutMs: options.landmarkTimeoutMs }),
      ...(options.downloadTimeoutMs === undefined
        ? {}
        : { downloadTimeoutMs: options.downloadTimeoutMs }),
    };
    processTrack = async (jobId) => ({ result: await processTrackJob(jobId, trackDeps) });
    log.warn("NATIVE_DOWNLOAD_MODE=browser: the paused browser path is on (see docs/PIVOT.md)");
  } else {
    // A worker that died mid-job can leave a login cookie file behind.
    await removeStaleCookieFiles(dataDir);
    const ytDlpDeps = {
      db: db.db,
      log,
      runner: options.runner ?? execFileRunner,
      command: env.YT_DLP_PATH,
      dataDir,
      minDownloadBytes: env.MIN_DOWNLOAD_BYTES,
    };
    processTrack = (jobId) => processYtDlpJob(jobId, ytDlpDeps);
  }

  const loop = startJobLoop({
    log,
    interruptedJobIds: () => interruptedJobIds(db.db),
    nextJobId: () => nextQueuedJobId(db.db),
    processTrack,
    recordCrash: async (jobId, error) => {
      const failed = await markJobFailed(db.db, {
        jobId,
        error: `The worker hit an unexpected error: ${errorMessage(error)}`,
      });
      // A job that never started stays QUEUED and is tried again after the pause.
      if (!failed.ok) log.warn({ jobId, kind: failed.kind }, "Crashed job left as it was");
      const found = await getJobContext(db.db, jobId);
      if (found !== null) await refreshRun(db.db, found.job.runId);
    },
    delay,
    pollIntervalMs: options.pollIntervalMs ?? WORKER_POLL_INTERVAL_MS,
  });

  const heartbeat = await startHeartbeat({ db: db.db, log });
  log.info(
    { concurrency: 1, dataDir, nativeDownloadMode: env.NATIVE_DOWNLOAD_MODE },
    "Worker ready, waiting for jobs",
  );

  return {
    ok: true,
    worker: {
      close: async () => {
        await loop.stop();
        // Closed cleanly so the persistent profile is not corrupted.
        await browser?.close();
        await heartbeat.stop();
        await db.close();
      },
    },
  };
}
