// What the worker writes while it processes one job. Every status change goes through
// `applyJobTransition`, and every change is recorded as an event in the same transaction.
import {
  transition,
  type AdapterState,
  type DownloadedFile,
  type HumanReason,
  type ManualReason,
  type StepOutcome,
} from "@gatecrusher/core";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  applyJobTransition,
  insertJobEvent,
  type JobChangeFailure,
  type JobRow,
} from "./job-transitions.ts";
import type { PlaylistRow, TrackRow } from "./playlists.ts";
import { downloads, humanRequests, jobs, playlists, runs, tracks } from "./schema.ts";

export type { JobChangeFailure, JobRow };

export interface JobContext {
  job: JobRow;
  track: TrackRow;
  playlist: Pick<PlaylistRow, "id" | "soundcloudUrl" | "title">;
}

/** A job with the track and playlist it belongs to, or `null` when there is no such job. */
export async function getJobContext(db: Database, jobId: string): Promise<JobContext | null> {
  const [row] = await db
    .select({
      job: jobs,
      track: tracks,
      playlist: {
        id: playlists.id,
        soundcloudUrl: playlists.soundcloudUrl,
        title: playlists.title,
      },
    })
    .from(jobs)
    .innerJoin(tracks, eq(jobs.trackId, tracks.id))
    .innerJoin(playlists, eq(tracks.playlistId, playlists.id))
    .where(eq(jobs.id, jobId));
  return row ?? null;
}

export interface StartJobInput {
  jobId: string;
  adapterId: string;
  /** True when the job continues in the tab it was parked in. */
  resumedOnOpenPage: boolean;
}

/**
 * QUEUED -> RUNNING. A job found RUNNING was interrupted by a worker that died mid-step
 * (browser jobs run one at a time, so nothing else can be running it): it is recovered
 * to QUEUED first, with an event, and then started.
 */
export async function startJob(
  db: Database,
  input: StartJobInput,
): Promise<{ ok: true; job: JobRow; recovered: boolean } | JobChangeFailure> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).for("update");
    if (current === undefined) {
      return { ok: false, kind: "job_not_found", reason: `No job ${input.jobId}` };
    }

    let status = current.status;
    const recovered = status === "RUNNING";
    if (recovered) {
      const requeued = transition(status, "recover");
      if (!requeued.ok) return requeued;
      status = requeued.status;
      await insertJobEvent(tx, {
        type: "recovered_after_restart",
        jobId: current.id,
        runId: current.runId,
        status: "QUEUED",
      });
    }

    const started = transition(status, "start");
    if (!started.ok) return started;

    const attempt = current.attempts + 1;
    const [job] = await tx
      .update(jobs)
      .set({ status: started.status, adapterId: input.adapterId, attempts: attempt, error: null })
      .where(eq(jobs.id, current.id))
      .returning();
    if (job === undefined) throw new Error("Job update returned no row");

    await insertJobEvent(tx, {
      type: "job_started",
      jobId: job.id,
      runId: job.runId,
      status: "RUNNING",
      adapterId: input.adapterId,
      attempt,
      resumedOnOpenPage: input.resumedOnOpenPage,
    });
    return { ok: true, job, recovered };
  });
}

interface StepRef {
  jobId: string;
  runId: string;
  stepIndex: number;
  stepName: string;
}

export async function recordStepStarted(db: Database, step: StepRef): Promise<void> {
  await insertJobEvent(db, { type: "step_started", status: "RUNNING", ...step });
}

export interface StepFinishedInput extends StepRef {
  outcome: StepOutcome;
  screenshotPath: string | null;
  /** Set when the step completed: where to re-enter from, and the state to keep. */
  checkpoint: { stepIndex: number; state: AdapterState } | null;
}

/** The step's event and, when it completed, the checkpoint — together or not at all. */
export async function recordStepFinished(db: Database, input: StepFinishedInput): Promise<void> {
  await db.transaction(async (tx) => {
    await insertJobEvent(tx, {
      type: "step_finished",
      status: "RUNNING",
      jobId: input.jobId,
      runId: input.runId,
      stepIndex: input.stepIndex,
      stepName: input.stepName,
      outcome: input.outcome,
      screenshotPath: input.screenshotPath,
    });
    if (input.checkpoint !== null) {
      await tx
        .update(jobs)
        .set({ stepIndex: input.checkpoint.stepIndex, state: input.checkpoint.state })
        .where(eq(jobs.id, input.jobId));
    }
  });
}

export async function recordAdapterNote(
  db: Database,
  note: { jobId: string; runId: string; message: string },
): Promise<void> {
  await insertJobEvent(db, {
    type: "adapter_note",
    status: "RUNNING",
    jobId: note.jobId,
    runId: note.runId,
    message: note.message.slice(0, 500),
  });
}

export interface ParkJobInput {
  jobId: string;
  adapterId: string;
  /** The step to re-enter when the human is done. */
  stepIndex: number;
  stepName: string;
  state: AdapterState;
  reason: HumanReason;
  description: string;
  screenshotPath: string;
  pageUrl: string;
}

/**
 * RUNNING -> WAITING_FOR_HUMAN. One transaction: the checkpoint, the `human_requests`
 * row, the status and the `needs_human` event.
 */
export async function parkJob(
  db: Database,
  input: ParkJobInput,
): Promise<{ ok: true; humanRequestId: string; attempt: number } | JobChangeFailure> {
  return db.transaction(async (tx) => {
    const applied = await applyJobTransition(tx, input.jobId, "needs_human", {
      stepIndex: input.stepIndex,
      state: input.state,
    });
    if (!applied.ok) return applied;
    const { job } = applied;

    // A job waits on at most one open request: an older one that is somehow still open
    // is superseded by this one.
    await tx
      .update(humanRequests)
      .set({ status: "SUPERSEDED", resolvedAt: sql`now()` })
      .where(and(eq(humanRequests.jobId, job.id), eq(humanRequests.status, "OPEN")));
    const [previous] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(humanRequests)
      .where(eq(humanRequests.jobId, job.id));
    const attempt = (previous?.count ?? 0) + 1;

    const [request] = await tx
      .insert(humanRequests)
      .values({
        jobId: job.id,
        reason: input.reason,
        description: input.description,
        screenshotPath: input.screenshotPath,
        pageUrl: input.pageUrl,
        adapterId: input.adapterId,
        stepIndex: input.stepIndex,
        stepName: input.stepName,
        attempt,
      })
      .returning({ id: humanRequests.id, createdAt: humanRequests.createdAt });
    if (request === undefined) throw new Error("Human request insert returned no row");

    await insertJobEvent(tx, {
      type: "needs_human",
      jobId: job.id,
      trackId: job.trackId,
      runId: job.runId,
      humanRequestId: request.id,
      adapterId: input.adapterId,
      stepIndex: input.stepIndex,
      stepName: input.stepName,
      reason: input.reason,
      description: input.description,
      screenshotPath: input.screenshotPath,
      pageUrl: input.pageUrl,
      sessionAlive: true,
      createdAt: request.createdAt.toISOString(),
    });
    return { ok: true, humanRequestId: request.id, attempt };
  });
}

/**
 * RUNNING -> SUCCEEDED, with the verified download recorded. A track has one download
 * row: a newer verified file replaces the record of an older one.
 */
export async function completeJob(
  db: Database,
  input: { jobId: string; download: DownloadedFile },
): Promise<{ ok: true; job: JobRow } | JobChangeFailure> {
  return db.transaction(async (tx) => {
    const applied = await applyJobTransition(tx, input.jobId, "succeed", {
      finishedAt: new Date(),
      error: null,
    });
    if (!applied.ok) return applied;
    const { job } = applied;

    const record = {
      jobId: job.id,
      filePath: input.download.path,
      sizeBytes: input.download.sizeBytes,
      mimeType: input.download.mimeType,
      kind: input.download.kind,
      checksumSha256: input.download.checksumSha256,
      verifiedAt: new Date(),
    };
    await tx
      .insert(downloads)
      .values({ trackId: job.trackId, ...record })
      .onConflictDoUpdate({ target: downloads.trackId, set: record });

    await insertJobEvent(tx, {
      type: "job_succeeded",
      jobId: job.id,
      runId: job.runId,
      status: "SUCCEEDED",
      download: input.download,
    });
    return { ok: true, job };
  });
}

/** RUNNING -> MANUAL. Hard rule: always with a reason and the link. */
export async function markJobManual(
  db: Database,
  input: { jobId: string; reason: ManualReason; detail: string; link: string },
): Promise<{ ok: true; job: JobRow } | JobChangeFailure> {
  return db.transaction(async (tx) => {
    const applied = await applyJobTransition(tx, input.jobId, "impossible", {
      manualReason: input.reason,
      manualDetail: input.detail,
      manualLink: input.link,
      finishedAt: new Date(),
    });
    if (!applied.ok) return applied;

    await insertJobEvent(tx, {
      type: "job_manual",
      jobId: applied.job.id,
      runId: applied.job.runId,
      status: "MANUAL",
      reason: input.reason,
      detail: input.detail,
      link: input.link,
    });
    return { ok: true, job: applied.job };
  });
}

/** RUNNING -> FAILED: a crash or an infrastructure problem. Retryable. */
export async function markJobFailed(
  db: Database,
  input: { jobId: string; error: string },
): Promise<{ ok: true; job: JobRow } | JobChangeFailure> {
  return db.transaction(async (tx) => {
    const error = input.error.trim().slice(0, 2_000) || "Unknown error";
    const applied = await applyJobTransition(tx, input.jobId, "fail", {
      error,
      finishedAt: new Date(),
    });
    if (!applied.ok) return applied;

    await insertJobEvent(tx, {
      type: "job_failed",
      jobId: applied.job.id,
      runId: applied.job.runId,
      status: "FAILED",
      error,
    });
    return { ok: true, job: applied.job };
  });
}

/**
 * Recomputes a run's counts and status from its jobs. A run is finished when nothing is
 * queued or running; jobs waiting for the human do not keep it "running".
 */
export async function refreshRun(db: Database, runId: string): Promise<void> {
  const grouped = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.runId, runId))
    .groupBy(jobs.status);

  const count = (status: JobRow["status"]) =>
    grouped.find((group) => group.status === status)?.count ?? 0;
  const active = count("QUEUED") + count("RUNNING") > 0;

  await db
    .update(runs)
    .set({
      totalJobs: grouped.reduce((total, group) => total + group.count, 0),
      succeededCount: count("SUCCEEDED"),
      manualCount: count("MANUAL"),
      failedCount: count("FAILED"),
      status: active ? "RUNNING" : "FINISHED",
      finishedAt: active ? null : sql`coalesce(${runs.finishedAt}, now())`,
    })
    .where(eq(runs.id, runId));
}
