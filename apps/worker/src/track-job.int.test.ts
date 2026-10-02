import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { jobEventSchema } from "@gatecrusher/core";
import { schema, startJob, startNativeRun } from "@gatecrusher/db";
import { asc, eq } from "drizzle-orm";
import { pino } from "pino";
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession, type BrowserSession } from "./browser.ts";
import { createParkedPages } from "./parked-pages.ts";
import { createWorkerTestBed, type FixturePage, type WorkerTestBed } from "./testing.ts";
import { processTrackJob, type TrackJobDeps } from "./track-job.ts";

// The real job processor, step runner, native adapter, download verification and
// Postgres, against local fixture pages in a headless browser. Nothing reaches SoundCloud.
const log = pino({ level: "silent" });

let bed: WorkerTestBed;
let browser: BrowserSession;
let deps: TrackJobDeps;

beforeAll(async () => {
  bed = await createWorkerTestBed();
  browser = createBrowserSession({
    profileDir: path.join(bed.dataDir, "browser-profile"),
    launch: bed.launchBrowser,
    log,
  });
  deps = {
    db: bed.db,
    log,
    browser,
    parked: createParkedPages(),
    registry: bed.registry,
    delay: bed.delay,
    dataDir: bed.dataDir,
    minDownloadBytes: 1_048_576,
    landmarkTimeoutMs: 750,
    downloadTimeoutMs: 1_500,
  };
});

afterAll(async () => {
  await bed.close();
});

afterEach(() => {
  expect(bed.violations()).toEqual([]);
});

/** Seeds a playlist, clicks "Run native tracks", and returns the queued job ids in order. */
async function queued(pages: readonly FixturePage[]) {
  const seededPlaylist = await bed.seedPlaylist(pages);
  const run = await startNativeRun(bed.db, seededPlaylist.playlistId);
  if (!run.ok || run.runId === null) throw new Error("expected a run");
  return { ...seededPlaylist, runId: run.runId, jobIds: run.newJobIds };
}

async function jobOf(jobId: string) {
  const [job] = await bed.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (job === undefined) throw new Error("job missing");
  return job;
}

async function eventsOf(jobId: string) {
  const rows = await bed.db
    .select()
    .from(schema.events)
    .where(eq(schema.events.jobId, jobId))
    .orderBy(asc(schema.events.id));
  for (const row of rows) jobEventSchema.parse(row.payload);
  return rows;
}

async function requestsOf(jobId: string) {
  return bed.db
    .select()
    .from(schema.humanRequests)
    .where(eq(schema.humanRequests.jobId, jobId))
    .orderBy(asc(schema.humanRequests.attempt));
}

/** The open tabs showing a fixture page (the profile's initial blank tab is not one). */
function tabsOn(name: string): Page[] {
  return (bed.context()?.pages() ?? []).filter((page) =>
    page.url().includes(`/fixture-artist/${name}`),
  );
}

async function filesIn(directory: string): Promise<string[]> {
  try {
    return await readdir(path.join(bed.dataDir, directory));
  } catch {
    // Not created yet: nothing was written there.
    return [];
  }
}

describe("processTrackJob: happy path", () => {
  it("downloads a native track, verifies it, stores it and records everything", async () => {
    const { jobIds, runId, trackIds, playlistId } = await queued([{ name: "track" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");

    const result = await processTrackJob(jobId, deps);

    expect(result).toEqual({ jobId, outcome: "succeeded" });
    expect(await jobOf(jobId)).toMatchObject({
      status: "SUCCEEDED",
      adapterId: "native-soundcloud",
      attempts: 1,
      error: null,
    });

    // The file: under the playlist's slug, named "<artist> - <title>.<ext>".
    const [download] = await bed.db.select().from(schema.downloads);
    expect(download).toMatchObject({
      trackId: trackIds[0],
      jobId,
      mimeType: "audio/mpeg",
      kind: "audio",
    });
    expect(download?.filePath).toMatch(
      /^downloads\/fixture-crate-\d+\/Fixture Artist - Fixture Track 1\.mp3$/,
    );
    expect(download?.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    const saved = await stat(path.join(bed.dataDir, download?.filePath ?? "missing"));
    expect(saved.size).toBe(download?.sizeBytes);
    expect(saved.size).toBeGreaterThan(1_048_576);

    // The events: every step with its name and a screenshot that exists.
    const events = await eventsOf(jobId);
    expect(events.map((event) => event.type)).toEqual([
      "job_started",
      "step_started",
      "step_finished",
      "step_started",
      "step_finished",
      "step_started",
      "step_finished",
      "job_succeeded",
    ]);
    const finished = events.filter((event) => event.type === "step_finished");
    expect(finished.map((event) => event.stepName)).toEqual([
      "open-track",
      "open-more",
      "download",
    ]);
    for (const event of finished) {
      expect(event.payload).toMatchObject({ status: "RUNNING" });
      const shot = await stat(path.join(bed.dataDir, event.screenshotPath ?? "missing"));
      expect(shot.size).toBeGreaterThan(0);
      expect(event.screenshotPath).toContain(`screenshots/${runId}/${jobId}/`);
    }

    // The run is finished, the tab is closed, and nothing is waiting.
    const [run] = await bed.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run).toMatchObject({ status: "FINISHED", succeededCount: 1, totalJobs: 1 });
    expect(tabsOn("track")).toEqual([]);

    // Already verified: running the playlist again creates nothing.
    const again = await startNativeRun(bed.db, playlistId);
    expect(again).toMatchObject({ ok: true, runId: null, newJobIds: [], alreadyDownloaded: 1 });
  });

  it("skips a job that is not runnable any more", async () => {
    const { jobIds } = await queued([{ name: "track" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");
    await processTrackJob(jobId, deps);
    const hits = bed.server.hits("/files/audio");

    expect(await processTrackJob(jobId, deps)).toEqual({ jobId, outcome: "skipped" });
    expect(bed.server.hits("/files/audio")).toBe(hits);
  });

  it("runs a job a dead worker left RUNNING, and says it was recovered", async () => {
    const { jobIds } = await queued([{ name: "track" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");
    await startJob(bed.db, { jobId, adapterId: "native-soundcloud", resumedOnOpenPage: false });

    const result = await processTrackJob(jobId, deps);

    expect(result.outcome).toBe("succeeded");
    expect((await eventsOf(jobId)).slice(0, 3).map((event) => event.type)).toEqual([
      "job_started",
      "recovered_after_restart",
      "job_started",
    ]);
  });
});

describe("processTrackJob: verification failure", () => {
  it.each([
    ["a file below the size threshold", "tiny"],
    ["an HTML page served as audio", "html"],
    ["a zip with no audio in it", "zip-no-audio"],
  ])("never marks success for %s, and cleans up", async (_label, file) => {
    const { jobIds } = await queued([{ name: "track", query: { file } }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");

    const result = await processTrackJob(jobId, deps);

    // Not a success, not a failure, not manual: the human gets to look at it.
    expect(result.outcome).toBe("parked");
    const job = await jobOf(jobId);
    expect(job).toMatchObject({ status: "WAITING_FOR_HUMAN", stepIndex: 2 });
    expect(await bed.db.$count(schema.downloads, eq(schema.downloads.jobId, jobId))).toBe(0);
    const [request] = await requestsOf(jobId);
    expect(request).toMatchObject({ reason: "unexpected_page", stepName: "download" });

    // No partial file anywhere under downloads/.
    const [playlist] = await bed.db
      .select({ url: schema.playlists.soundcloudUrl })
      .from(schema.playlists)
      .innerJoin(schema.tracks, eq(schema.tracks.playlistId, schema.playlists.id))
      .where(eq(schema.tracks.id, job.trackId));
    const slug = playlist?.url.split("/").at(-1) ?? "missing";
    expect(await filesIn(path.join("downloads", slug))).toEqual([]);

    for (const tab of tabsOn("track")) await tab.close();
  });
});

describe("processTrackJob: blockers", () => {
  it("parks on a captcha, keeps the tab open, and resumes from the same step on retry", async () => {
    const { jobIds, playlistId, runId } = await queued([{ name: "captcha" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");
    const pageHits = bed.server.hits("/fixture-artist/captcha");

    // 1. The captcha appears after "open-more": the job parks there.
    expect(await processTrackJob(jobId, deps)).toEqual({ jobId, outcome: "parked" });
    expect(await jobOf(jobId)).toMatchObject({
      status: "WAITING_FOR_HUMAN",
      stepIndex: 1,
      finishedAt: null,
    });
    const [request] = await requestsOf(jobId);
    expect(request).toMatchObject({
      reason: "captcha",
      description: "Solve the captcha in the worker's browser window.",
      status: "OPEN",
      attempt: 1,
      stepIndex: 1,
      stepName: "open-more",
      sessionAlive: true,
    });
    expect(request?.pageUrl).toBe(bed.server.pageUrl("captcha"));
    const shot = await stat(path.join(bed.dataDir, request?.screenshotPath ?? "missing"));
    expect(shot.size).toBeGreaterThan(0);
    expect((await eventsOf(jobId)).at(-1)).toMatchObject({
      type: "needs_human",
      stepName: "open-more",
      screenshotPath: request?.screenshotPath,
    });
    const [tab] = tabsOn("captcha");
    if (tab === undefined) throw new Error("the parked tab was closed");
    expect(await tab.locator("iframe").count()).toBe(1);
    const [run] = await bed.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run?.status).toBe("FINISHED");

    // 2. Retried while the captcha is still there: parked again, nothing touched.
    await startNativeRun(bed.db, playlistId);
    expect(await processTrackJob(jobId, deps)).toEqual({ jobId, outcome: "parked" });
    expect((await requestsOf(jobId)).map((row) => [row.attempt, row.status])).toEqual([
      [1, "CONTINUED"],
      [2, "OPEN"],
    ]);
    expect(await jobOf(jobId)).toMatchObject({ status: "WAITING_FOR_HUMAN", stepIndex: 1 });
    expect(tabsOn("captcha")).toEqual([tab]);

    // 3. The human solves it and clicks "Run native tracks" again.
    await tab.evaluate(() => (window as unknown as { __solveCaptcha(): void }).__solveCaptcha());
    const retry = await startNativeRun(bed.db, playlistId);
    expect(retry).toMatchObject({ ok: true, resumedJobIds: [jobId], newJobIds: [] });
    const eventsBefore = (await eventsOf(jobId)).length;

    expect(await processTrackJob(jobId, deps)).toEqual({ jobId, outcome: "succeeded" });

    const resumedEvents = (await eventsOf(jobId)).slice(eventsBefore);
    expect(resumedEvents[0]).toMatchObject({
      type: "job_started",
      payload: { resumedOnOpenPage: true, attempt: 3 },
    });
    // Same tab, same step: "open-track" is not run again and the page is not reloaded.
    expect(
      resumedEvents.filter((event) => event.type === "step_started").map((event) => event.stepName),
    ).toEqual(["open-more", "download"]);
    expect(bed.server.hits("/fixture-artist/captcha")).toBe(pageHits + 1);
    expect(await jobOf(jobId)).toMatchObject({ status: "SUCCEEDED" });
    expect(tabsOn("captcha")).toEqual([]);
  });

  it("does not hold up the next track while one is parked", async () => {
    const { jobIds } = await queued([{ name: "captcha" }, { name: "track" }]);
    const [first, second] = jobIds;
    if (first === undefined || second === undefined) throw new Error("expected two jobs");

    expect((await processTrackJob(first, deps)).outcome).toBe("parked");
    expect((await processTrackJob(second, deps)).outcome).toBe("succeeded");

    expect(await jobOf(first)).toMatchObject({ status: "WAITING_FOR_HUMAN" });
    expect(await jobOf(second)).toMatchObject({ status: "SUCCEEDED" });
    // The parked tab is still there, on its own page.
    expect(tabsOn("captcha")).toHaveLength(1);
    for (const tab of tabsOn("captcha")) await tab.close();
  });

  it("reports a signed-out burner account as needs_human, not as a failure", async () => {
    const { jobIds } = await queued([{ name: "signed-out" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");

    expect(await processTrackJob(jobId, deps)).toEqual({ jobId, outcome: "parked" });

    expect(await jobOf(jobId)).toMatchObject({
      status: "WAITING_FOR_HUMAN",
      stepIndex: 0,
      error: null,
    });
    const [request] = await requestsOf(jobId);
    expect(request).toMatchObject({ reason: "login_challenge", stepName: "open-track" });
    expect(request?.description).toContain("not signed in");
    for (const tab of tabsOn("signed-out")) await tab.close();
  });

  it("starts over on a new tab when the parked one was closed, and parks again if still blocked", async () => {
    const { jobIds, playlistId } = await queued([{ name: "signed-out" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");
    await processTrackJob(jobId, deps);
    for (const tab of tabsOn("signed-out")) await tab.close();
    const pageHits = bed.server.hits("/fixture-artist/signed-out");

    await startNativeRun(bed.db, playlistId);
    expect(await processTrackJob(jobId, deps)).toEqual({ jobId, outcome: "parked" });

    const lastStart = (await eventsOf(jobId))
      .filter((event) => event.type === "job_started")
      .at(-1);
    expect(lastStart?.payload).toMatchObject({ resumedOnOpenPage: false });
    expect(bed.server.hits("/fixture-artist/signed-out")).toBe(pageHits + 1);
    expect((await requestsOf(jobId)).at(-1)).toMatchObject({ attempt: 2, status: "OPEN" });
    for (const tab of tabsOn("signed-out")) await tab.close();
  });

  it.each([
    ["a sign-in form", "login-challenge", "login_challenge"],
    ["a page it does not recognise", "unexpected", "unexpected_page"],
  ])("parks on %s", async (_label, name, reason) => {
    const { jobIds } = await queued([{ name }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");

    expect((await processTrackJob(jobId, deps)).outcome).toBe("parked");

    expect(await jobOf(jobId)).toMatchObject({ status: "WAITING_FOR_HUMAN", manualReason: null });
    expect((await requestsOf(jobId))[0]).toMatchObject({ reason });
    for (const tab of tabsOn(name)) await tab.close();
  });
});

describe("processTrackJob: manual and failed", () => {
  it("marks a removed track manual, with the reason and the link", async () => {
    const { jobIds } = await queued([{ name: "removed" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");

    expect(await processTrackJob(jobId, deps)).toEqual({ jobId, outcome: "manual" });

    const job = await jobOf(jobId);
    expect(job).toMatchObject({
      status: "MANUAL",
      manualReason: "dead_link",
      manualLink: bed.server.pageUrl("removed"),
    });
    expect(job.manualDetail).toContain("removed or made private");
    expect(await requestsOf(jobId)).toEqual([]);
    expect(tabsOn("removed")).toEqual([]);
  });

  it("marks a track whose download was turned off manual as file gone", async () => {
    const { jobIds } = await queued([{ name: "download-disabled" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");

    expect((await processTrackJob(jobId, deps)).outcome).toBe("manual");

    expect(await jobOf(jobId)).toMatchObject({
      status: "MANUAL",
      manualReason: "file_gone",
      manualLink: bed.server.pageUrl("download-disabled"),
    });
  });

  it("records an infrastructure error as FAILED, at the job boundary", async () => {
    const { jobIds, runId } = await queued([{ name: "track" }]);
    const [jobId] = jobIds;
    if (jobId === undefined) throw new Error("expected a job");
    const broken: TrackJobDeps = {
      ...deps,
      browser: {
        newPage: () => Promise.reject(new Error("Chromium is not installed")),
        close: () => Promise.resolve(),
      },
    };

    expect(await processTrackJob(jobId, broken)).toEqual({ jobId, outcome: "failed" });

    expect(await jobOf(jobId)).toMatchObject({
      status: "FAILED",
      error: "Chromium is not installed",
    });
    expect((await eventsOf(jobId)).at(-1)).toMatchObject({ type: "job_failed" });
    const [run] = await bed.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run).toMatchObject({ status: "FINISHED", failedCount: 1 });
  });

  it("rejects a job id that does not exist", async () => {
    await expect(processTrackJob("00000000-0000-4000-8000-000000000000", deps)).rejects.toThrow(
      "does not exist",
    );
  });
});
