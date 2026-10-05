// One native download without a browser: yt-dlp fetches the uploader's own file.
//
// Only the `download` format is ever asked for — the file the uploader enabled for
// download on SoundCloud. There is no fallback to a stream: a track whose uploader did
// not enable download is never fetched here (see docs/PIVOT.md).
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { playlistSlug, type TrackJobResult } from "@gatecrusher/core";
import {
  completeJob,
  getJobContext,
  markJobFailed,
  markJobManual,
  recordStepFinished,
  recordStepStarted,
  refreshRun,
  startJob,
  type Database,
} from "@gatecrusher/db";
import { createFileStore, type FileStore } from "@gatecrusher/gates";
import type { Logger } from "pino";
import type { ProcessRunner } from "./process-runner.ts";

export const YTDLP_ADAPTER_ID = "yt-dlp";
export const YTDLP_STEP_NAME = "yt-dlp-download";

/** Big uploads over a slow line; yt-dlp itself retries transient errors. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
/** How long the worker stops taking jobs after SoundCloud pushes back. */
export const RATE_LIMIT_BACK_OFF_MS = 10 * 60 * 1_000;

export interface YtDlpJobDeps {
  db: Database;
  log: Logger;
  runner: ProcessRunner;
  /** yt-dlp executable name or path. */
  command: string;
  /** Absolute path of the data dir. */
  dataDir: string;
  minDownloadBytes: number;
  timeoutMs?: number;
}

export interface TrackOutcome {
  result: TrackJobResult;
  /** Set when SoundCloud pushed back: the worker should stop taking jobs for this long. */
  backOffMs?: number;
}

/** What yt-dlp's failure means for the job. Decided from its stderr, never guessed. */
export type YtDlpFailure =
  | { kind: "not_installed" }
  | { kind: "timeout" }
  /** The uploader's download is not offered (any more). */
  | { kind: "download_not_offered" }
  | { kind: "track_gone" }
  /** 403 / 429: SoundCloud is refusing this client for now. */
  | { kind: "rate_limited" }
  | { kind: "other"; detail: string };

export function classifyYtDlpFailure(failure: {
  kind: "not_installed" | "timeout" | "failed";
  detail: string;
}): YtDlpFailure {
  if (failure.kind !== "failed") return { kind: failure.kind };
  const { detail } = failure;
  if (/requested format is not available/i.test(detail)) return { kind: "download_not_offered" };
  if (/HTTP Error 4(03|29)|too many requests|rate.?limit/i.test(detail)) {
    return { kind: "rate_limited" };
  }
  if (/HTTP Error 404|not found|has been removed|private/i.test(detail)) {
    return { kind: "track_gone" };
  }
  return { kind: "other", detail: detail.slice(0, 500) };
}

/** The exact command line. `--` ends the options, so the URL can never be read as one. */
export function ytDlpArgs(outputTemplate: string, trackUrl: string): string[] {
  return [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    // The uploader's original file and nothing else: no stream is ever ripped.
    "--format",
    "download",
    "--no-overwrites",
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    "--output",
    outputTemplate,
    "--print",
    "after_move:filepath",
    "--",
    trackUrl,
  ];
}

/** yt-dlp wrote the file under the partial name plus its own extension. */
async function findPartialFile(store: FileStore, partial: string): Promise<string | null> {
  const prefix = path.basename(partial);
  const names = (await readdir(store.directory)).filter((name) => name.startsWith(prefix));
  const [name] = names;
  return name === undefined ? null : path.join(store.directory, name);
}

async function removePartials(store: FileStore, partial: string): Promise<void> {
  const prefix = path.basename(partial);
  for (const name of await readdir(store.directory)) {
    if (name.startsWith(prefix)) await rm(path.join(store.directory, name), { force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one `track` job with yt-dlp to its resting point: a verified download, a
 * genuinely-impossible verdict, or a failure. Anything thrown is caught here, the job
 * boundary, and recorded as FAILED (retryable).
 */
export async function processYtDlpJob(jobId: string, deps: YtDlpJobDeps): Promise<TrackOutcome> {
  const found = await getJobContext(deps.db, jobId);
  if (found === null) throw new Error(`Track job ${jobId} does not exist`);
  const { job, track, playlist } = found;
  const log = deps.log.child({
    jobId,
    runId: job.runId,
    trackId: track.id,
    adapterId: YTDLP_ADAPTER_ID,
  });

  if (job.status !== "QUEUED" && job.status !== "RUNNING") {
    log.info({ status: job.status }, "Job is not runnable any more, skipping");
    return { result: { jobId, outcome: "skipped" } };
  }

  const started = await startJob(deps.db, {
    jobId,
    adapterId: YTDLP_ADAPTER_ID,
    resumedOnOpenPage: false,
  });
  if (!started.ok) {
    log.warn({ kind: started.kind, reason: started.reason }, "Job could not be started, skipping");
    return { result: { jobId, outcome: "skipped" } };
  }
  if (started.recovered) log.warn("Job was interrupted by a worker restart; running it again");

  const ids = { jobId, runId: job.runId };
  const step = { ...ids, stepIndex: 0, stepName: YTDLP_STEP_NAME };
  const finish = (outcome: "done" | "impossible" | "needs_human") =>
    recordStepFinished(deps.db, { ...step, outcome, screenshotPath: null, checkpoint: null });

  const store = createFileStore({
    dataDir: deps.dataDir,
    minBytes: deps.minDownloadBytes,
    target: {
      playlistSlug: playlistSlug(playlist.soundcloudUrl, playlist.title),
      artist: track.artist,
      title: track.title,
    },
  });
  const partial = store.partialPath();

  try {
    if (track.classification !== "native") {
      throw new Error(
        `Only native tracks are downloaded with yt-dlp (track is ${track.classification})`,
      );
    }
    await mkdir(store.directory, { recursive: true });
    await recordStepStarted(deps.db, step);
    log.info({ step: YTDLP_STEP_NAME }, "Step started");

    const run = await deps.runner.run(
      deps.command,
      ytDlpArgs(`${partial}.%(ext)s`, track.permalinkUrl),
      { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );

    if (!run.ok) {
      await removePartials(store, partial);
      const failure = classifyYtDlpFailure(run);
      log.warn({ failure: failure.kind }, "yt-dlp did not deliver the file");
      switch (failure.kind) {
        case "download_not_offered":
          return await settleManual(
            "file_gone",
            "SoundCloud no longer offers the uploader's download for this track: it was turned off or its download limit was reached.",
          );
        case "track_gone":
          return await settleManual(
            "dead_link",
            "SoundCloud has no track at this link any more: it was removed or made private.",
          );
        case "rate_limited":
          return {
            ...(await settleFailed(
              "SoundCloud refused the download (rate limited or blocked). The worker pauses before trying anything else.",
            )),
            backOffMs: RATE_LIMIT_BACK_OFF_MS,
          };
        case "not_installed":
          return await settleFailed("yt-dlp is not installed. Install it or set YT_DLP_PATH.");
        case "timeout":
          return await settleFailed("yt-dlp timed out downloading the file.");
        case "other":
          return await settleFailed(`yt-dlp failed: ${failure.detail}`);
      }
    }

    const written = await findPartialFile(store, partial);
    if (written === null) {
      return await settleFailed("yt-dlp reported success but wrote no file.");
    }
    const attempt = await store.keep(written);
    if (!attempt.ok) {
      log.warn({ kind: attempt.kind, reason: attempt.reason }, "yt-dlp download not accepted");
      return await settleFailed(
        `The file yt-dlp delivered is not a usable download: ${attempt.reason}.`,
      );
    }

    await finish("done");
    const completed = await completeJob(deps.db, { jobId, download: attempt.download });
    if (!completed.ok) throw new Error(completed.reason);
    log.info(
      { file: attempt.download.path, sizeBytes: attempt.download.sizeBytes },
      "Download verified",
    );
    return { result: { jobId, outcome: "succeeded" } };
  } catch (error) {
    log.error({ err: error }, "Track job failed");
    await removePartials(store, partial);
    const failed = await markJobFailed(deps.db, { jobId, error: errorMessage(error) });
    if (!failed.ok)
      log.error({ kind: failed.kind, reason: failed.reason }, "Could not record the failure");
    return { result: { jobId, outcome: "failed" } };
  } finally {
    await refreshRun(deps.db, job.runId);
  }

  async function settleManual(
    reason: "file_gone" | "dead_link",
    detail: string,
  ): Promise<TrackOutcome> {
    await finish("impossible");
    const marked = await markJobManual(deps.db, {
      jobId,
      reason,
      detail,
      link: track.permalinkUrl,
    });
    if (!marked.ok) throw new Error(marked.reason);
    log.info({ reason }, "Track is not obtainable; marked manual");
    return { result: { jobId, outcome: "manual" } };
  }

  async function settleFailed(message: string): Promise<TrackOutcome> {
    const failed = await markJobFailed(deps.db, { jobId, error: message });
    if (!failed.ok) throw new Error(failed.reason);
    return { result: { jobId, outcome: "failed" } };
  }
}
