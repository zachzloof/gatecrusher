import { QUEUE_NAME, WORKER_HEARTBEAT_KEY, type WorkerEnv } from "@gatecrusher/core";
import { createDb } from "@gatecrusher/db";
import {
  createDelayProvider,
  registry as defaultRegistry,
  type AdapterRegistry,
  type BrowserGateAdapter,
  type DelayProvider,
} from "@gatecrusher/gates";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import {
  createBrowserSession,
  launchHeadedBrowser,
  type BrowserLauncher,
  type BrowserSession,
} from "./browser.ts";
import { removeStaleCookieFiles } from "./cookie-file.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { createParkedPages } from "./parked-pages.ts";
import { browserProfileDir, resolveDataDir } from "./paths.ts";
import { execFileRunner, type ProcessRunner } from "./process-runner.ts";
import { processJob, type TrackOutcome } from "./processor.ts";
import { processTrackJob, type TrackJobDeps } from "./track-job.ts";
import { processYtDlpJob } from "./ytdlp-job.ts";

export interface StartWorkerOptions {
  env: WorkerEnv;
  log: Logger;
  /** Overridable so integration tests can run beside a real worker. */
  queueName?: string;
  queuePrefix?: string;
  heartbeatKey?: string;
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
  | { ok: true; worker: RunningWorker }
  | { ok: false; kind: "postgres_unreachable" | "redis_unreachable"; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One connection attempt with no retries, so a wrong URL fails fast at startup. */
async function probeRedis(url: string): Promise<void> {
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  // The rejection from connect()/ping() below carries the failure; this listener only
  // stops ioredis from also reporting it as an unhandled "error" event.
  probe.on("error", () => undefined);
  try {
    await probe.connect();
    await probe.ping();
  } finally {
    probe.disconnect();
  }
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

  try {
    await probeRedis(env.REDIS_URL);
  } catch (error) {
    await db.close();
    return {
      ok: false,
      kind: "redis_unreachable",
      reason: `Cannot reach Redis at REDIS_URL (${errorMessage(error)}). Is \`docker compose up -d\` running?`,
    };
  }

  // BullMQ requires `maxRetriesPerRequest: null` on connections it blocks on.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on("error", (error) => log.warn({ err: error }, "Redis connection error"));
  log.info("Connected to Redis");

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

  let resumeTimer: NodeJS.Timeout | undefined;
  const queueName = options.queueName ?? QUEUE_NAME;
  const worker = new Worker(
    queueName,
    (job) =>
      processJob(job, {
        log,
        delay,
        processTrack,
        backOff: (ms) => {
          // pause(true) does not wait for the active job: this runs from inside it.
          void worker.pause(true);
          clearTimeout(resumeTimer);
          resumeTimer = setTimeout(() => {
            void worker.resume();
            log.info("Queue resumed after the back-off");
          }, ms);
          resumeTimer.unref();
        },
      }),
    {
      connection: redis,
      // Hard rule: one download at a time.
      concurrency: 1,
      ...(options.queuePrefix === undefined ? {} : { prefix: options.queuePrefix }),
    },
  );
  worker.on("completed", (job) =>
    log.info({ queueJobId: job.id, jobName: job.name }, "Queue job completed"),
  );
  worker.on("failed", (job, error) =>
    log.error({ queueJobId: job?.id, jobName: job?.name, err: error }, "Queue job failed"),
  );
  worker.on("error", (error) => log.error({ err: error }, "Queue worker error"));
  await worker.waitUntilReady();

  const heartbeat = await startHeartbeat({
    redis,
    key: options.heartbeatKey ?? WORKER_HEARTBEAT_KEY,
    log,
  });
  log.info(
    { queue: queueName, concurrency: 1, dataDir, nativeDownloadMode: env.NATIVE_DOWNLOAD_MODE },
    "Worker ready, waiting for jobs",
  );

  return {
    ok: true,
    worker: {
      close: async () => {
        clearTimeout(resumeTimer);
        await worker.close();
        // Closed cleanly so the persistent profile is not corrupted.
        await browser?.close();
        await heartbeat.stop();
        await redis.quit();
        await db.close();
      },
    },
  };
}
