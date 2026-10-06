// What the web app reads and writes about runs: starting one, and where each track of a
// playlist currently stands.
import type { DownloadKind, HumanReason, JobStatus, ManualReason } from "@gatecrusher/core";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { applyJobTransition, insertJobEvent } from "./job-transitions.ts";
import { refreshRun } from "./jobs.ts";
import { downloads, events, humanRequests, jobs, playlists, runs, tracks } from "./schema.ts";

export type StartPlaylistRunResult =
  | {
      ok: true;
      /** The run created for tracks that needed a new job, or `null` when none did. */
      runId: string | null;
      /** New jobs, in playlist order. */
      newJobIds: string[];
      /** Jobs that were waiting for the human and are queued again, at their checkpoint. */
      resumedJobIds: string[];
      /** Jobs that were already queued. Handing them to the queue again is harmless. */
      queuedJobIds: string[];
      /** Tracks skipped because they already have a verified download. */
      alreadyDownloaded: number;
      /** Tracks whose job is running right now. */
      alreadyRunning: number;
    }
  | { ok: false; kind: "playlist_not_found"; reason: string };

/**
 * Decides what "Download tracks" does for each track of a playlist, whatever its
 * classification (the worker picks how each one is fetched):
 *
 * - verified download            -> skipped
 * - job queued or running        -> left alone
 * - job waiting for the human    -> queued again (same job, same checkpoint)
 * - anything else                -> a new job in a new run
 *
 * One transaction, holding the playlist row, so two clicks cannot both create jobs.
 */
export async function startPlaylistRun(
  db: Database,
  playlistId: string,
): Promise<StartPlaylistRunResult> {
  return db.transaction(async (tx) => {
    const [playlist] = await tx
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.id, playlistId))
      .for("update");
    if (playlist === undefined) {
      return { ok: false, kind: "playlist_not_found", reason: "No such playlist." };
    }

    const playlistTracks = await tx
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.playlistId, playlistId))
      .orderBy(asc(tracks.position), asc(tracks.id));
    const trackIds = playlistTracks.map((track) => track.id);

    const result: Extract<StartPlaylistRunResult, { ok: true }> = {
      ok: true,
      runId: null,
      newJobIds: [],
      resumedJobIds: [],
      queuedJobIds: [],
      alreadyDownloaded: 0,
      alreadyRunning: 0,
    };
    if (trackIds.length === 0) return result;

    const verified = new Set(
      (
        await tx
          .select({ trackId: downloads.trackId })
          .from(downloads)
          .where(inArray(downloads.trackId, trackIds))
      ).map((row) => row.trackId),
    );
    const latestJobs = new Map(
      (
        await tx
          .selectDistinctOn([jobs.trackId], {
            id: jobs.id,
            trackId: jobs.trackId,
            runId: jobs.runId,
            status: jobs.status,
          })
          .from(jobs)
          .where(inArray(jobs.trackId, trackIds))
          .orderBy(jobs.trackId, desc(jobs.createdAt), desc(jobs.id))
      ).map((job) => [job.trackId, job]),
    );

    const needNewJob: string[] = [];
    const resumedRunIds = new Set<string>();
    for (const trackId of trackIds) {
      if (verified.has(trackId)) {
        result.alreadyDownloaded += 1;
        continue;
      }
      const job = latestJobs.get(trackId);
      switch (job?.status) {
        case "QUEUED":
          result.queuedJobIds.push(job.id);
          break;
        case "RUNNING":
          result.alreadyRunning += 1;
          break;
        case "WAITING_FOR_HUMAN": {
          const continued = await applyJobTransition(tx, job.id, "continue");
          if (!continued.ok) throw new Error(continued.reason);
          await insertJobEvent(tx, {
            type: "job_continued",
            jobId: job.id,
            runId: job.runId,
            status: "QUEUED",
          });
          await tx
            .update(humanRequests)
            .set({ status: "CONTINUED", resolvedAt: sql`now()` })
            .where(and(eq(humanRequests.jobId, job.id), eq(humanRequests.status, "OPEN")));
          result.resumedJobIds.push(job.id);
          resumedRunIds.add(job.runId);
          break;
        }
        case undefined:
        case "SUCCEEDED":
        case "MANUAL":
        case "FAILED":
        case "CANCELLED":
          needNewJob.push(trackId);
          break;
      }
    }

    if (resumedRunIds.size > 0) {
      await tx
        .update(runs)
        .set({ status: "RUNNING", finishedAt: null })
        .where(inArray(runs.id, [...resumedRunIds]));
    }

    if (needNewJob.length > 0) {
      const [run] = await tx
        .insert(runs)
        .values({ playlistId, totalJobs: needNewJob.length })
        .returning({ id: runs.id });
      if (run === undefined) throw new Error("Run insert returned no row");
      const created = await tx
        .insert(jobs)
        .values(needNewJob.map((trackId) => ({ runId: run.id, trackId })))
        .returning({ id: jobs.id, trackId: jobs.trackId });
      const idByTrack = new Map(created.map((job) => [job.trackId, job.id]));
      result.runId = run.id;
      result.newJobIds = needNewJob.flatMap((trackId) => idByTrack.get(trackId) ?? []);
    }
    return result;
  });
}

export type CancelPlaylistRunResult =
  | {
      ok: true;
      /** Queued jobs that were cancelled. */
      cancelled: number;
      /** Jobs already running: each finishes, and nothing starts after it. */
      running: number;
    }
  | { ok: false; kind: "playlist_not_found"; reason: string };

/**
 * "Cancel": every queued job of the playlist becomes CANCELLED, so the worker skips it
 * when the queue hands it over. A running job is left to finish. Holds the playlist row
 * like `startPlaylistRun`, so a cancel and a start never interleave.
 */
export async function cancelPlaylistRun(
  db: Database,
  playlistId: string,
): Promise<CancelPlaylistRunResult> {
  const outcome = await db.transaction(async (tx) => {
    const [playlist] = await tx
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.id, playlistId))
      .for("update");
    if (playlist === undefined) {
      return { ok: false, kind: "playlist_not_found", reason: "No such playlist." } as const;
    }

    const active = await tx
      .select({ id: jobs.id, runId: jobs.runId, status: jobs.status })
      .from(jobs)
      .innerJoin(tracks, eq(jobs.trackId, tracks.id))
      .where(and(eq(tracks.playlistId, playlistId), inArray(jobs.status, ["QUEUED", "RUNNING"])));

    let cancelled = 0;
    let running = 0;
    const runIds = new Set<string>();
    for (const job of active) {
      // The transition re-reads the row under a lock: a job the worker started in the
      // meantime is refused, and counted as running.
      const changed = await applyJobTransition(tx, job.id, "cancel", { finishedAt: new Date() });
      if (!changed.ok) {
        running += 1;
        continue;
      }
      await insertJobEvent(tx, {
        type: "job_cancelled",
        jobId: job.id,
        runId: job.runId,
        status: "CANCELLED",
      });
      cancelled += 1;
      runIds.add(job.runId);
    }
    return { ok: true, cancelled, running, runIds: [...runIds] } as const;
  });
  if (!outcome.ok) return outcome;

  for (const runId of outcome.runIds) await refreshRun(db, runId);
  return { ok: true, cancelled: outcome.cancelled, running: outcome.running };
}

export interface TrackRunState {
  /** The track's most recent job. */
  job: {
    id: string;
    status: JobStatus;
    /** The step a running or waiting job is on. */
    stepName: string | null;
    manualReason: ManualReason | null;
    manualDetail: string | null;
    error: string | null;
  } | null;
  /** What the job is waiting on, while it is waiting for the human. */
  humanRequest: { reason: HumanReason; description: string; screenshotPath: string } | null;
  download: { filePath: string; sizeBytes: number; kind: DownloadKind } | null;
}

/** Where each track of a playlist stands, keyed by track id. Tracks with no history are absent. */
export async function getPlaylistTrackStates(
  db: Database,
  playlistId: string,
): Promise<Map<string, TrackRunState>> {
  const [latestJobs, files] = await Promise.all([
    db
      .selectDistinctOn([jobs.trackId], {
        id: jobs.id,
        trackId: jobs.trackId,
        status: jobs.status,
        manualReason: jobs.manualReason,
        manualDetail: jobs.manualDetail,
        error: jobs.error,
      })
      .from(jobs)
      .innerJoin(tracks, eq(jobs.trackId, tracks.id))
      .where(eq(tracks.playlistId, playlistId))
      .orderBy(jobs.trackId, desc(jobs.createdAt), desc(jobs.id)),
    db
      .select({
        trackId: downloads.trackId,
        filePath: downloads.filePath,
        sizeBytes: downloads.sizeBytes,
        kind: downloads.kind,
      })
      .from(downloads)
      .innerJoin(tracks, eq(downloads.trackId, tracks.id))
      .where(eq(tracks.playlistId, playlistId)),
  ]);

  const inProgress = latestJobs
    .filter((job) => job.status === "RUNNING" || job.status === "WAITING_FOR_HUMAN")
    .map((job) => job.id);
  const [requests, steps] =
    inProgress.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              jobId: humanRequests.jobId,
              reason: humanRequests.reason,
              description: humanRequests.description,
              screenshotPath: humanRequests.screenshotPath,
            })
            .from(humanRequests)
            .where(and(inArray(humanRequests.jobId, inProgress), eq(humanRequests.status, "OPEN"))),
          db
            .selectDistinctOn([events.jobId], { jobId: events.jobId, stepName: events.stepName })
            .from(events)
            .where(and(inArray(events.jobId, inProgress), isNotNull(events.stepName)))
            .orderBy(events.jobId, desc(events.id)),
        ]);

  const requestByJob = new Map(requests.map((request) => [request.jobId, request]));
  const stepByJob = new Map(steps.map((step) => [step.jobId, step.stepName]));
  const states = new Map<string, TrackRunState>();

  for (const job of latestJobs) {
    const request = requestByJob.get(job.id);
    states.set(job.trackId, {
      job: {
        id: job.id,
        status: job.status,
        stepName: stepByJob.get(job.id) ?? null,
        manualReason: job.manualReason,
        manualDetail: job.manualDetail,
        error: job.error,
      },
      humanRequest:
        request === undefined
          ? null
          : {
              reason: request.reason,
              description: request.description,
              screenshotPath: request.screenshotPath,
            },
      download: null,
    });
  }
  for (const file of files) {
    const state = states.get(file.trackId) ?? { job: null, humanRequest: null, download: null };
    state.download = { filePath: file.filePath, sizeBytes: file.sizeBytes, kind: file.kind };
    states.set(file.trackId, state);
  }
  return states;
}

/**
 * Whether a screenshot path was recorded by a job. The screenshot route serves nothing
 * else, so a request can never name a file the worker did not write.
 */
export async function isRecordedScreenshot(db: Database, screenshotPath: string): Promise<boolean> {
  const [request] = await db
    .select({ id: humanRequests.id })
    .from(humanRequests)
    .where(eq(humanRequests.screenshotPath, screenshotPath))
    .limit(1);
  if (request !== undefined) return true;

  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.screenshotPath, screenshotPath))
    .limit(1);
  return event !== undefined;
}
