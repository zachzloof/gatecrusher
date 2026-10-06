import { jobEventSchema, type DownloadedFile } from "@gatecrusher/core";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./client.ts";
import {
  completeJob,
  getJobContext,
  markJobFailed,
  markJobManual,
  parkJob,
  recordStepFinished,
  recordStepStarted,
  refreshRun,
  startJob,
} from "./jobs.ts";
import { deletePlaylist, savePlaylistIngest, type ClassifiedTrack } from "./playlists.ts";
import {
  cancelPlaylistRun,
  getPlaylistTrackStates,
  isRecordedScreenshot,
  startPlaylistRun,
} from "./runs.ts";
import { downloads, events, humanRequests, jobs, playlists, runs, tracks } from "./schema.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.handle.db;
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  // Cascades to tracks, runs, jobs, events, downloads and human requests.
  await db.delete(playlists);
});

function track(id: string, overrides: Partial<ClassifiedTrack> = {}): ClassifiedTrack {
  return {
    soundcloudId: id,
    title: `Track ${id}`,
    artist: "Fixture Artist",
    permalinkUrl: `https://soundcloud.com/fixture-artist/track-${id}`,
    artworkUrl: null,
    durationMs: 300_000,
    purchaseUrl: null,
    purchaseTitle: null,
    downloadable: true,
    classification: "native",
    gatePlatform: null,
    ...overrides,
  };
}

/** A playlist with three native tracks, one gate and one buy track. */
async function seedPlaylist(): Promise<{ playlistId: string; trackIds: Record<string, string> }> {
  const { playlistId } = await savePlaylistIngest(db, {
    soundcloudUrl: "https://soundcloud.com/fixture-curator/sets/fixture-crate",
    source: "api_v2",
    soundcloudId: "9001",
    title: "Fixture crate",
    owner: "fixture-curator",
    artworkUrl: null,
    tracks: [
      track("n1"),
      track("g1", {
        classification: "gate",
        gatePlatform: "hypeddit",
        downloadable: false,
        purchaseUrl: "https://hypeddit.com/track/fixture",
      }),
      track("n2"),
      track("b1", {
        classification: "buy",
        downloadable: false,
        purchaseUrl: "https://fixture-label.bandcamp.com/track/b1",
      }),
      track("n3"),
    ],
  });
  const rows = await db.select().from(tracks).where(eq(tracks.playlistId, playlistId));
  return {
    playlistId,
    trackIds: Object.fromEntries(rows.map((row) => [row.soundcloudId, row.id])),
  };
}

const download: DownloadedFile = {
  path: "downloads/fixture-crate/Fixture Artist - Track n1.mp3",
  sizeBytes: 2_000_000,
  mimeType: "audio/mpeg",
  kind: "audio",
  checksumSha256: "a".repeat(64),
};

async function started(jobId: string) {
  const result = await startJob(db, {
    jobId,
    adapterId: "native-soundcloud",
    resumedOnOpenPage: false,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.job;
}

function park(jobId: string, overrides: Partial<Parameters<typeof parkJob>[1]> = {}) {
  return parkJob(db, {
    jobId,
    adapterId: "native-soundcloud",
    stepIndex: 1,
    stepName: "open-more",
    state: { seen: true },
    reason: "captcha",
    description: "Solve the captcha in the worker's browser window.",
    screenshotPath: `screenshots/run/${jobId}/0002-open-more.png`,
    pageUrl: "https://soundcloud.com/fixture-artist/track-n1",
    ...overrides,
  });
}

async function jobOf(jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (job === undefined) throw new Error("job missing");
  return job;
}

async function eventsOf(jobId: string) {
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.jobId, jobId))
    .orderBy(asc(events.id));
  // Every stored payload must still satisfy the schema it was written through.
  for (const row of rows) jobEventSchema.parse(row.payload);
  return rows;
}

describe("startPlaylistRun", () => {
  it("creates one queued job per track, whatever its classification, in playlist order", async () => {
    const { playlistId, trackIds } = await seedPlaylist();

    const result = await startPlaylistRun(db, playlistId);

    expect(result).toMatchObject({ ok: true, alreadyDownloaded: 0, alreadyRunning: 0 });
    if (!result.ok || result.runId === null) throw new Error("expected a run");
    expect(result.newJobIds).toHaveLength(5);
    const created = await Promise.all(result.newJobIds.map(jobOf));
    expect(created.map((job) => job.trackId)).toEqual([
      trackIds.n1,
      trackIds.g1,
      trackIds.n2,
      trackIds.b1,
      trackIds.n3,
    ]);
    expect(new Set(created.map((job) => job.status))).toEqual(new Set(["QUEUED"]));
    expect(await db.$count(jobs)).toBe(5);
    const [run] = await db.select().from(runs).where(eq(runs.id, result.runId));
    expect(run).toMatchObject({ playlistId, status: "RUNNING", totalJobs: 5 });
  });

  it("skips tracks that already have a verified download", async () => {
    const { playlistId, trackIds } = await seedPlaylist();
    const first = await startPlaylistRun(db, playlistId);
    if (!first.ok) throw new Error("expected a run");
    const [jobId] = first.newJobIds;
    if (jobId === undefined) throw new Error("expected a job");
    await started(jobId);
    await completeJob(db, { jobId, download });
    await db.delete(jobs).where(eq(jobs.trackId, trackIds.n2 ?? ""));
    await db.delete(jobs).where(eq(jobs.trackId, trackIds.n3 ?? ""));

    const second = await startPlaylistRun(db, playlistId);

    expect(second).toMatchObject({ ok: true, alreadyDownloaded: 1 });
    if (!second.ok) return;
    expect(second.newJobIds).toHaveLength(2);
    expect(await db.$count(jobs, eq(jobs.trackId, trackIds.n1 ?? ""))).toBe(1);
  });

  it("leaves queued and running jobs alone when clicked again", async () => {
    const { playlistId } = await seedPlaylist();
    const first = await startPlaylistRun(db, playlistId);
    if (!first.ok) throw new Error("expected a run");
    const [runningId, ...queuedIds] = first.newJobIds;
    if (runningId === undefined) throw new Error("expected a job");
    await started(runningId);

    const second = await startPlaylistRun(db, playlistId);

    expect(second).toMatchObject({
      ok: true,
      runId: null,
      newJobIds: [],
      resumedJobIds: [],
      alreadyRunning: 1,
    });
    expect(second.ok && [...second.queuedJobIds].sort()).toEqual([...queuedIds].sort());
    expect(await db.$count(jobs)).toBe(5);
    expect(await db.$count(runs)).toBe(1);
  });

  it("queues a parked job again in place, at its checkpoint, and closes its request", async () => {
    const { playlistId } = await seedPlaylist();
    const first = await startPlaylistRun(db, playlistId);
    if (!first.ok || first.runId === null) throw new Error("expected a run");
    const [parkedId, ...others] = first.newJobIds;
    if (parkedId === undefined) throw new Error("expected a job");
    await started(parkedId);
    await park(parkedId);
    for (const jobId of others) {
      await started(jobId);
      await markJobFailed(db, { jobId, error: "browser crashed" });
    }
    await refreshRun(db, first.runId);
    expect((await db.select().from(runs))[0]?.status).toBe("FINISHED");

    const second = await startPlaylistRun(db, playlistId);

    if (!second.ok) throw new Error("expected ok");
    expect(second.resumedJobIds).toEqual([parkedId]);
    // The four failed tracks get new jobs in a new run.
    expect(second.newJobIds).toHaveLength(4);
    expect(second.runId).not.toBe(first.runId);

    expect(await jobOf(parkedId)).toMatchObject({
      status: "QUEUED",
      stepIndex: 1,
      state: { seen: true },
      runId: first.runId,
    });
    expect((await eventsOf(parkedId)).at(-1)?.type).toBe("job_continued");
    const requests = await db.select().from(humanRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ status: "CONTINUED" });
    expect(requests[0]?.resolvedAt).toBeInstanceOf(Date);
    const [firstRun] = await db.select().from(runs).where(eq(runs.id, first.runId));
    expect(firstRun).toMatchObject({ status: "RUNNING", finishedAt: null });
  });

  it("gives a track marked manual a fresh job on the next run", async () => {
    const { playlistId, trackIds } = await seedPlaylist();
    const first = await startPlaylistRun(db, playlistId);
    if (!first.ok) throw new Error("expected a run");
    const [jobId] = first.newJobIds;
    if (jobId === undefined) throw new Error("expected a job");
    await started(jobId);
    await markJobManual(db, {
      jobId,
      reason: "dead_link",
      detail: "Removed",
      link: "https://soundcloud.com/fixture-artist/track-n1",
    });

    const second = await startPlaylistRun(db, playlistId);

    if (!second.ok) throw new Error("expected ok");
    expect(second.newJobIds).toHaveLength(1);
    expect((await jobOf(second.newJobIds[0] ?? "")).trackId).toBe(trackIds.n1);
  });

  it("does nothing for a playlist with no tracks", async () => {
    const { playlistId } = await savePlaylistIngest(db, {
      soundcloudUrl: "https://soundcloud.com/fixture-curator/sets/empty",
      source: "api_v2",
      soundcloudId: "9002",
      title: "Empty",
      owner: null,
      artworkUrl: null,
      tracks: [],
    });

    expect(await startPlaylistRun(db, playlistId)).toEqual({
      ok: true,
      runId: null,
      newJobIds: [],
      resumedJobIds: [],
      queuedJobIds: [],
      alreadyDownloaded: 0,
      alreadyRunning: 0,
    });
    expect(await db.$count(runs)).toBe(0);
  });

  it("reports an unknown playlist", async () => {
    expect(await startPlaylistRun(db, "00000000-0000-4000-8000-000000000000")).toMatchObject({
      ok: false,
      kind: "playlist_not_found",
    });
  });

  it("does not create duplicate jobs when clicked twice at once", async () => {
    const { playlistId } = await seedPlaylist();

    const [a, b] = await Promise.all([
      startPlaylistRun(db, playlistId),
      startPlaylistRun(db, playlistId),
    ]);

    expect(a.ok && b.ok).toBe(true);
    expect(await db.$count(jobs)).toBe(5);
    expect(await db.$count(runs)).toBe(1);
  });
});

describe("cancelPlaylistRun", () => {
  it("cancels every queued job, leaves the running one, and finishes the run", async () => {
    const { playlistId } = await seedPlaylist();
    const first = await startPlaylistRun(db, playlistId);
    if (!first.ok || first.runId === null) throw new Error("expected a run");
    const [runningId, ...queuedIds] = first.newJobIds;
    if (runningId === undefined) throw new Error("expected a job");
    await started(runningId);

    const result = await cancelPlaylistRun(db, playlistId);

    expect(result).toEqual({ ok: true, cancelled: 4, running: 1 });
    for (const jobId of queuedIds) {
      const job = await jobOf(jobId);
      expect(job.status).toBe("CANCELLED");
      expect(job.finishedAt).toBeInstanceOf(Date);
      expect((await eventsOf(jobId)).at(-1)?.type).toBe("job_cancelled");
    }
    expect((await jobOf(runningId)).status).toBe("RUNNING");
    // Still running: the run finishes once that job does.
    const [run] = await db.select().from(runs).where(eq(runs.id, first.runId));
    expect(run?.status).toBe("RUNNING");

    await completeJob(db, { jobId: runningId, download });
    await refreshRun(db, first.runId);
    const [after] = await db.select().from(runs).where(eq(runs.id, first.runId));
    expect(after).toMatchObject({ status: "FINISHED", succeededCount: 1 });
  });

  it("queues cancelled tracks again on the next run", async () => {
    const { playlistId } = await seedPlaylist();
    await startPlaylistRun(db, playlistId);
    await cancelPlaylistRun(db, playlistId);

    const second = await startPlaylistRun(db, playlistId);

    expect(second.ok && second.newJobIds).toHaveLength(5);
  });

  it("does nothing when nothing is queued, and is safe to click twice", async () => {
    const { playlistId } = await seedPlaylist();
    expect(await cancelPlaylistRun(db, playlistId)).toEqual({ ok: true, cancelled: 0, running: 0 });

    await startPlaylistRun(db, playlistId);
    await cancelPlaylistRun(db, playlistId);
    expect(await cancelPlaylistRun(db, playlistId)).toEqual({ ok: true, cancelled: 0, running: 0 });
  });

  it("leaves other playlists' queues alone", async () => {
    const { playlistId } = await seedPlaylist();
    const { playlistId: otherId } = await savePlaylistIngest(db, {
      soundcloudUrl: "https://soundcloud.com/fixture-curator/sets/other",
      source: "api_v2",
      soundcloudId: "9003",
      title: "Other",
      owner: null,
      artworkUrl: null,
      tracks: [track("o1")],
    });
    const other = await startPlaylistRun(db, otherId);
    await startPlaylistRun(db, playlistId);

    await cancelPlaylistRun(db, playlistId);

    expect((await jobOf((other.ok && other.newJobIds[0]) || "")).status).toBe("QUEUED");
  });

  it("reports an unknown playlist", async () => {
    expect(await cancelPlaylistRun(db, "00000000-0000-4000-8000-000000000000")).toMatchObject({
      ok: false,
      kind: "playlist_not_found",
    });
  });
});

describe("deletePlaylist", () => {
  it("removes the playlist and everything recorded about it, and hands back its files", async () => {
    const { playlistId } = await seedPlaylist();
    const run = await startPlaylistRun(db, playlistId);
    if (!run.ok) throw new Error("expected a run");
    const [jobId] = run.newJobIds;
    if (jobId === undefined) throw new Error("expected a job");
    await started(jobId);
    await completeJob(db, { jobId, download });

    const result = await deletePlaylist(db, playlistId);

    expect(result).toEqual({ ok: true, filePaths: [download.path] });
    expect(await db.$count(playlists)).toBe(0);
    expect(await db.$count(tracks)).toBe(0);
    expect(await db.$count(runs)).toBe(0);
    expect(await db.$count(jobs)).toBe(0);
    expect(await db.$count(events)).toBe(0);
    expect(await db.$count(downloads)).toBe(0);
  });

  it("is refused while one of its tracks is downloading", async () => {
    const { playlistId } = await seedPlaylist();
    const run = await startPlaylistRun(db, playlistId);
    if (!run.ok) throw new Error("expected a run");
    await started(run.newJobIds[0] ?? "");

    const result = await deletePlaylist(db, playlistId);

    expect(result).toMatchObject({ ok: false, kind: "busy" });
    expect(await db.$count(playlists)).toBe(1);
  });

  it("deletes a playlist whose tracks are only queued", async () => {
    const { playlistId } = await seedPlaylist();
    await startPlaylistRun(db, playlistId);

    expect(await deletePlaylist(db, playlistId)).toEqual({ ok: true, filePaths: [] });
    expect(await db.$count(jobs)).toBe(0);
  });

  it("reports an unknown playlist", async () => {
    expect(await deletePlaylist(db, "00000000-0000-4000-8000-000000000000")).toMatchObject({
      ok: false,
      kind: "playlist_not_found",
    });
  });
});

describe("job lifecycle", () => {
  async function oneJob() {
    const { playlistId, trackIds } = await seedPlaylist();
    const result = await startPlaylistRun(db, playlistId);
    if (!result.ok || result.runId === null) throw new Error("expected a run");
    const [jobId] = result.newJobIds;
    if (jobId === undefined) throw new Error("expected a job");
    return { playlistId, trackIds, runId: result.runId, jobId };
  }

  it("loads a job with its track and playlist", async () => {
    const { jobId, trackIds, playlistId } = await oneJob();

    const found = await getJobContext(db, jobId);

    expect(found?.job.id).toBe(jobId);
    expect(found?.track).toMatchObject({ id: trackIds.n1, classification: "native" });
    expect(found?.playlist).toEqual({
      id: playlistId,
      soundcloudUrl: "https://soundcloud.com/fixture-curator/sets/fixture-crate",
      title: "Fixture crate",
    });
    expect(await getJobContext(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("starts a queued job and records it", async () => {
    const { jobId } = await oneJob();

    const result = await startJob(db, {
      jobId,
      adapterId: "native-soundcloud",
      resumedOnOpenPage: false,
    });

    expect(result).toMatchObject({ ok: true, recovered: false });
    expect(await jobOf(jobId)).toMatchObject({
      status: "RUNNING",
      adapterId: "native-soundcloud",
      attempts: 1,
    });
    expect((await eventsOf(jobId)).map((event) => event.type)).toEqual(["job_started"]);
  });

  it("recovers a job a dead worker left RUNNING, then starts it", async () => {
    const { jobId } = await oneJob();
    await started(jobId);

    const result = await startJob(db, {
      jobId,
      adapterId: "native-soundcloud",
      resumedOnOpenPage: false,
    });

    expect(result).toMatchObject({ ok: true, recovered: true });
    expect(await jobOf(jobId)).toMatchObject({ status: "RUNNING", attempts: 2 });
    expect((await eventsOf(jobId)).map((event) => event.type)).toEqual([
      "job_started",
      "recovered_after_restart",
      "job_started",
    ]);
  });

  it.each(["succeed", "park", "manual"] as const)(
    "refuses to start a job that has already ended in %s",
    async (ending) => {
      const { jobId } = await oneJob();
      await started(jobId);
      if (ending === "succeed") await completeJob(db, { jobId, download });
      if (ending === "park") await park(jobId);
      if (ending === "manual") {
        await markJobManual(db, {
          jobId,
          reason: "file_gone",
          detail: "x",
          link: "https://a.example/x",
        });
      }

      const result = await startJob(db, {
        jobId,
        adapterId: "native-soundcloud",
        resumedOnOpenPage: false,
      });

      expect(result).toMatchObject({ ok: false, kind: "illegal_transition" });
    },
  );

  it("writes step events with status, step name and screenshot path, and checkpoints", async () => {
    const { jobId, runId } = await oneJob();
    await started(jobId);
    const step = { jobId, runId, stepIndex: 0, stepName: "open-track" };

    await recordStepStarted(db, step);
    await recordStepFinished(db, {
      ...step,
      outcome: "next",
      screenshotPath: "screenshots/run/job/0001-open-track.png",
      checkpoint: { stepIndex: 1, state: { opened: true } },
    });

    const [, startedEvent, finishedEvent] = await eventsOf(jobId);
    expect(startedEvent).toMatchObject({
      type: "step_started",
      stepIndex: 0,
      stepName: "open-track",
    });
    expect(finishedEvent).toMatchObject({
      type: "step_finished",
      stepIndex: 0,
      stepName: "open-track",
      screenshotPath: "screenshots/run/job/0001-open-track.png",
      payload: { status: "RUNNING", outcome: "next" },
    });
    expect(await jobOf(jobId)).toMatchObject({ stepIndex: 1, state: { opened: true } });
  });

  it("does not move the checkpoint for a step that did not complete", async () => {
    const { jobId, runId } = await oneJob();
    await started(jobId);

    await recordStepFinished(db, {
      jobId,
      runId,
      stepIndex: 0,
      stepName: "open-track",
      outcome: "needs_human",
      screenshotPath: "screenshots/run/job/0001-open-track.png",
      checkpoint: null,
    });

    expect(await jobOf(jobId)).toMatchObject({ stepIndex: 0, state: {} });
  });

  it("parks a job: status, checkpoint, human request and event together", async () => {
    const { jobId, runId, trackIds } = await oneJob();
    await started(jobId);

    const result = await park(jobId);

    expect(result).toMatchObject({ ok: true, attempt: 1 });
    expect(await jobOf(jobId)).toMatchObject({
      status: "WAITING_FOR_HUMAN",
      stepIndex: 1,
      state: { seen: true },
      finishedAt: null,
    });
    const [request] = await db.select().from(humanRequests);
    expect(request).toMatchObject({
      jobId,
      reason: "captcha",
      status: "OPEN",
      attempt: 1,
      sessionAlive: true,
      stepIndex: 1,
      stepName: "open-more",
    });
    const event = (await eventsOf(jobId)).at(-1);
    expect(event).toMatchObject({
      type: "needs_human",
      stepName: "open-more",
      payload: { humanRequestId: request?.id, trackId: trackIds.n1, runId, reason: "captcha" },
    });
  });

  it("counts attempts when a job is parked again after a retry", async () => {
    const { jobId, playlistId } = await oneJob();
    await started(jobId);
    await park(jobId);
    await startPlaylistRun(db, playlistId);
    await started(jobId);

    const again = await park(jobId);

    expect(again).toMatchObject({ ok: true, attempt: 2 });
    const requests = await db.select().from(humanRequests).orderBy(asc(humanRequests.attempt));
    expect(requests.map((request) => [request.attempt, request.status])).toEqual([
      [1, "CONTINUED"],
      [2, "OPEN"],
    ]);
  });

  it("refuses to park a job with a description that is not a short instruction", async () => {
    const { jobId } = await oneJob();
    await started(jobId);

    await expect(park(jobId, { description: "x".repeat(281) })).rejects.toThrow();
    // The whole transaction rolled back.
    expect(await jobOf(jobId)).toMatchObject({ status: "RUNNING" });
    expect(await db.$count(humanRequests)).toBe(0);
  });

  it("completes a job with a download row carrying size, MIME type and checksum", async () => {
    const { jobId, trackIds } = await oneJob();
    await started(jobId);

    expect(await completeJob(db, { jobId, download })).toMatchObject({ ok: true });

    const job = await jobOf(jobId);
    expect(job.status).toBe("SUCCEEDED");
    expect(job.finishedAt).toBeInstanceOf(Date);
    const [row] = await db.select().from(downloads);
    expect(row).toMatchObject({
      trackId: trackIds.n1,
      jobId,
      filePath: download.path,
      sizeBytes: 2_000_000,
      mimeType: "audio/mpeg",
      kind: "audio",
      checksumSha256: "a".repeat(64),
    });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect((await eventsOf(jobId)).at(-1)?.type).toBe("job_succeeded");
  });

  it("marks a job manual with its reason, detail and link", async () => {
    const { jobId } = await oneJob();
    await started(jobId);

    await markJobManual(db, {
      jobId,
      reason: "dead_link",
      detail: "SoundCloud has no track at this link any more.",
      link: "https://soundcloud.com/fixture-artist/track-n1",
    });

    expect(await jobOf(jobId)).toMatchObject({
      status: "MANUAL",
      manualReason: "dead_link",
      manualDetail: "SoundCloud has no track at this link any more.",
      manualLink: "https://soundcloud.com/fixture-artist/track-n1",
    });
    expect((await eventsOf(jobId)).at(-1)).toMatchObject({
      type: "job_manual",
      payload: { reason: "dead_link" },
    });
  });

  it("marks a job failed with its error", async () => {
    const { jobId } = await oneJob();
    await started(jobId);

    await markJobFailed(db, { jobId, error: "Target page, context or browser has been closed" });

    expect(await jobOf(jobId)).toMatchObject({
      status: "FAILED",
      error: "Target page, context or browser has been closed",
    });
    expect((await eventsOf(jobId)).at(-1)).toMatchObject({
      type: "job_failed",
      error: "Target page, context or browser has been closed",
    });
  });

  it.each([
    ["complete", (jobId: string) => completeJob(db, { jobId, download })],
    ["park", (jobId: string) => park(jobId)],
    ["fail", (jobId: string) => markJobFailed(db, { jobId, error: "x" })],
  ])("refuses to %s a job that is not running, and writes nothing", async (_label, act) => {
    const { jobId } = await oneJob();

    expect(await act(jobId)).toMatchObject({ ok: false, kind: "illegal_transition" });
    expect(await jobOf(jobId)).toMatchObject({ status: "QUEUED" });
    expect(await eventsOf(jobId)).toEqual([]);
    expect(await db.$count(downloads)).toBe(0);
  });

  it("recounts a run and finishes it once nothing is queued or running", async () => {
    const { playlistId } = await seedPlaylist();
    const result = await startPlaylistRun(db, playlistId);
    if (!result.ok || result.runId === null) throw new Error("expected a run");
    const [a, b, c, d, e] = result.newJobIds;
    if (a === undefined || b === undefined || c === undefined) throw new Error("expected jobs");
    if (d === undefined || e === undefined) throw new Error("expected jobs");
    const runOf = async () =>
      (
        await db
          .select()
          .from(runs)
          .where(eq(runs.id, result.runId ?? ""))
      )[0];

    await started(a);
    await completeJob(db, { jobId: a, download });
    await started(b);
    await park(b);
    await refreshRun(db, result.runId);
    expect(await runOf()).toMatchObject({ status: "RUNNING", succeededCount: 1, finishedAt: null });

    await started(c);
    await markJobManual(db, {
      jobId: c,
      reason: "file_gone",
      detail: "x",
      link: "https://a.example/x",
    });
    for (const jobId of [d, e]) {
      await started(jobId);
      await markJobFailed(db, { jobId, error: "x" });
    }
    await refreshRun(db, result.runId);

    // One job is still waiting for the human: the run is finished, waiting on you.
    const run = await runOf();
    expect(run).toMatchObject({
      status: "FINISHED",
      totalJobs: 5,
      succeededCount: 1,
      manualCount: 1,
      failedCount: 2,
    });
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });
});

describe("getPlaylistTrackStates", () => {
  it("is empty for a playlist nothing has run for", async () => {
    const { playlistId } = await seedPlaylist();

    expect((await getPlaylistTrackStates(db, playlistId)).size).toBe(0);
  });

  it("reports each track's latest job, open request, current step and download", async () => {
    const { playlistId, trackIds } = await seedPlaylist();
    const result = await startPlaylistRun(db, playlistId);
    if (!result.ok || result.runId === null) throw new Error("expected a run");
    // The native tracks n1, n2 and n3; the gate and buy tracks between them stay queued.
    const [a, , b, , c] = result.newJobIds;
    if (a === undefined || b === undefined || c === undefined) throw new Error("expected jobs");
    await started(a);
    await completeJob(db, { jobId: a, download });
    await started(b);
    await park(b);
    await started(c);
    await recordStepStarted(db, {
      jobId: c,
      runId: result.runId,
      stepIndex: 0,
      stepName: "open-track",
    });
    await recordStepStarted(db, {
      jobId: c,
      runId: result.runId,
      stepIndex: 1,
      stepName: "open-more",
    });

    const states = await getPlaylistTrackStates(db, playlistId);

    expect(states.size).toBe(5);
    expect(states.get(trackIds.g1 ?? "")).toMatchObject({ job: { status: "QUEUED" } });
    expect(states.get(trackIds.n1 ?? "")).toMatchObject({
      job: { status: "SUCCEEDED" },
      humanRequest: null,
      download: { filePath: download.path, sizeBytes: 2_000_000, kind: "audio" },
    });
    expect(states.get(trackIds.n2 ?? "")).toMatchObject({
      job: { status: "WAITING_FOR_HUMAN", stepName: "open-more" },
      humanRequest: {
        reason: "captcha",
        description: "Solve the captcha in the worker's browser window.",
        screenshotPath: `screenshots/run/${b}/0002-open-more.png`,
      },
      download: null,
    });
    expect(states.get(trackIds.n3 ?? "")).toMatchObject({
      job: { status: "RUNNING", stepName: "open-more" },
      humanRequest: null,
    });
  });

  it("reports the newest job when a track has been run more than once", async () => {
    const { playlistId, trackIds } = await seedPlaylist();
    const first = await startPlaylistRun(db, playlistId);
    if (!first.ok) throw new Error("expected a run");
    for (const jobId of first.newJobIds) {
      await started(jobId);
      await markJobFailed(db, { jobId, error: "first attempt" });
    }
    const second = await startPlaylistRun(db, playlistId);
    if (!second.ok) throw new Error("expected a run");

    const states = await getPlaylistTrackStates(db, playlistId);

    expect(states.get(trackIds.n1 ?? "")?.job).toMatchObject({ status: "QUEUED", error: null });
    expect(second.newJobIds).toContain(states.get(trackIds.n1 ?? "")?.job?.id);
  });
});

describe("isRecordedScreenshot", () => {
  it("knows only the paths jobs recorded", async () => {
    const { playlistId } = await seedPlaylist();
    const result = await startPlaylistRun(db, playlistId);
    if (!result.ok || result.runId === null) throw new Error("expected a run");
    const [jobId] = result.newJobIds;
    if (jobId === undefined) throw new Error("expected a job");
    await started(jobId);
    await recordStepFinished(db, {
      jobId,
      runId: result.runId,
      stepIndex: 0,
      stepName: "open-track",
      outcome: "next",
      screenshotPath: "screenshots/run/job/0001-open-track.png",
      checkpoint: { stepIndex: 1, state: {} },
    });
    await park(jobId, { screenshotPath: "screenshots/run/job/0002-open-more.png" });

    expect(await isRecordedScreenshot(db, "screenshots/run/job/0001-open-track.png")).toBe(true);
    expect(await isRecordedScreenshot(db, "screenshots/run/job/0002-open-more.png")).toBe(true);
    expect(await isRecordedScreenshot(db, "screenshots/run/job/0003-other.png")).toBe(false);
    expect(await isRecordedScreenshot(db, "../../.env")).toBe(false);
  });
});
