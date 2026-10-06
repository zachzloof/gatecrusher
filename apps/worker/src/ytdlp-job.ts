// One track downloaded without a browser, by yt-dlp.
//
// A native track gets the uploader's own file (the `download` format) and nothing else.
// Every other track gets the uploader's file if there is one, else the best stream the
// signed-in account can play (256k AAC with Go+), with tags and artwork embedded. Both
// land in the playlist's download folder. A stream SoundCloud only serves DRM-protected
// is never circumvented: the track is marked manual. Every run carries the owner's
// connected login.
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { playlistSlug, type TrackClassification, type TrackJobResult } from "@gatecrusher/core";
import {
  completeJob,
  getJobContext,
  getSoundcloudOauthToken,
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
import { writeSoundcloudCookieFile } from "./cookie-file.ts";
import type { ProcessRunner } from "./process-runner.ts";

export const YTDLP_ADAPTER_ID = "yt-dlp";
export const YTDLP_STEP_NAME = "yt-dlp-download";
export const YTDLP_STREAM_STEP_NAME = "yt-dlp-stream";

/** What a track is fetched as: the uploader's file only, or that file else the best stream. */
export type YtDlpSource = "download" | "stream";

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
  /** SoundCloud only serves the track encrypted. */
  | { kind: "drm_protected" }
  /** Embedding tags and artwork needs ffmpeg. */
  | { kind: "ffmpeg_missing" }
  /** SoundCloud did not accept the stored login token (expired, or signed out). */
  | { kind: "login_rejected" }
  /** SoundCloud answered as if nobody was signed in. */
  | { kind: "login_required" }
  /** 403 / 429: SoundCloud is refusing this client for now. */
  | { kind: "rate_limited" }
  | { kind: "other"; detail: string };

export function classifyYtDlpFailure(failure: {
  kind: "not_installed" | "timeout" | "failed";
  detail: string;
}): YtDlpFailure {
  if (failure.kind !== "failed") return { kind: failure.kind };
  const { detail } = failure;
  // The login problems only show as warnings, printed before the final error. Without
  // them a missing login would read as "requested format is not available": file gone.
  if (/authorization token is invalid/i.test(detail)) return { kind: "login_rejected" };
  if (/only available for registered users/i.test(detail)) return { kind: "login_required" };
  // The verdict is the ERROR line; warnings above it may mention unrelated HTTP errors,
  // or that ffmpeg is missing when nothing needed it.
  const errors = detail
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith("ERROR:"))
    .join("\n");
  const verdict = errors === "" ? detail : errors;
  // Before the "not found" check below, which this wording would also match.
  if (/ffmpeg not found|ffmpeg-location/i.test(verdict)) return { kind: "ffmpeg_missing" };
  if (/DRM protected/i.test(verdict)) return { kind: "drm_protected" };
  if (/requested format is not available/i.test(verdict)) return { kind: "download_not_offered" };
  if (/HTTP Error 4(03|29)|too many requests|rate.?limit/i.test(verdict)) {
    return { kind: "rate_limited" };
  }
  if (/HTTP Error 404|not found|has been removed|private/i.test(verdict)) {
    return { kind: "track_gone" };
  }
  return { kind: "other", detail: verdict.slice(0, 500) };
}

const RECONNECT = "Connect SoundCloud again in Settings, then click Download tracks.";

export const NOT_CONNECTED_MESSAGE =
  "No SoundCloud account is connected, and SoundCloud only hands an uploader's file or its best stream to a signed-in account. Connect one in Settings, then click Download tracks.";

const FORMAT_OPTIONS: Record<YtDlpSource, readonly string[]> = {
  // The uploader's original file and nothing else.
  download: ["--format", "download"],
  // The uploader's file when there is one, else the best stream, tagged with its artwork.
  stream: ["--format", "download/bestaudio", "--embed-metadata", "--embed-thumbnail"],
};

/** Native tracks get the uploader's file only; every other track falls back to the stream. */
export function sourceFor(classification: TrackClassification): YtDlpSource {
  return classification === "native" ? "download" : "stream";
}

/**
 * The exact command line. `--` ends the options, so the URL can never be read as one.
 * The login comes from a cookie file, never from an argument other processes can read.
 * Warnings stay on: the login problems are reported only as warnings.
 */
export function ytDlpArgs(
  outputTemplate: string,
  trackUrl: string,
  cookieFile: string,
  source: YtDlpSource,
): string[] {
  return [
    "--no-playlist",
    "--no-progress",
    "--cookies",
    cookieFile,
    ...FORMAT_OPTIONS[source],
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

/** What yt-dlp can leave beside the audio: the artwork it embeds, unfinished parts. */
const SIDE_FILE = /\.(jpe?g|png|webp|part|ytdl)$/i;

/** yt-dlp wrote the file under the partial name plus its own extension. */
async function findPartialFile(store: FileStore, partial: string): Promise<string | null> {
  const prefix = path.basename(partial);
  const names = (await readdir(store.directory)).filter(
    (name) => name.startsWith(prefix) && !SIDE_FILE.test(name),
  );
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
  if (found === null) {
    // Its playlist was deleted after the job was queued.
    deps.log.info({ jobId }, "Job no longer exists, skipping");
    return { result: { jobId, outcome: "skipped" } };
  }
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

  const source = sourceFor(track.classification);
  const ids = { jobId, runId: job.runId };
  const step = {
    ...ids,
    stepIndex: 0,
    stepName: source === "download" ? YTDLP_STEP_NAME : YTDLP_STREAM_STEP_NAME,
  };
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
  let cookieFile: string | null = null;

  try {
    const oauthToken = await getSoundcloudOauthToken(deps.db);
    if (oauthToken === null) {
      log.warn("No SoundCloud account is connected");
      return await settleFailed(NOT_CONNECTED_MESSAGE);
    }

    await mkdir(store.directory, { recursive: true });
    await recordStepStarted(deps.db, step);
    log.info({ step: step.stepName, source }, "Step started");

    cookieFile = await writeSoundcloudCookieFile(deps.dataDir, jobId, oauthToken);
    const run = await deps.runner.run(
      deps.command,
      ytDlpArgs(`${partial}.%(ext)s`, track.permalinkUrl, cookieFile, source),
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
            source === "download"
              ? "SoundCloud no longer offers the uploader's download for this track: it was turned off or its download limit was reached."
              : "SoundCloud offers neither a download nor a playable stream for this track.",
          );
        case "drm_protected":
          return await settleManual(
            "drm_protected",
            "SoundCloud only streams this track DRM-protected and offers no download. Buy it or get it from the artist.",
          );
        case "ffmpeg_missing":
          return await settleFailed(
            "yt-dlp needs ffmpeg to embed the tags and artwork. Install it (winget install Gyan.FFmpeg), restart the worker, then click Download tracks.",
          );
        case "track_gone":
          return await settleManual(
            "dead_link",
            "SoundCloud has no track at this link any more: it was removed or made private.",
          );
        case "login_rejected":
          return await settleFailed(
            `SoundCloud did not accept the saved login: it expired, or the account was signed out of SoundCloud. ${RECONNECT}`,
          );
        case "login_required":
          return await settleFailed(
            `SoundCloud treated the download as not signed in, and only hands this file to a signed-in account. ${RECONNECT}`,
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
    if (cookieFile !== null) {
      // Logged, not thrown: the run's counters below must still be refreshed. Stale
      // files are also removed when the worker starts.
      await rm(cookieFile, { force: true }).catch((error: unknown) =>
        log.error({ err: error }, "Could not delete the login cookie file"),
      );
    }
    await refreshRun(deps.db, job.runId);
  }

  async function settleManual(
    reason: "file_gone" | "dead_link" | "drm_protected",
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
