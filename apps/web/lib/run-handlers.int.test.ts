import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  completeJob,
  createDb,
  parkJob,
  recordStepStarted,
  savePlaylistIngest,
  schema,
  startJob,
  type ClassifiedTrack,
  type Database,
} from "@gatecrusher/db";
import { createTestDatabase, type TestDatabase } from "@gatecrusher/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  playlistDetailResponseSchema,
  runNativeResponseSchema,
} from "./api-schemas";
import { handleGetPlaylist } from "./playlist-handlers";
import { handleRunNative, handleScreenshot, type RunHandlerDeps } from "./run-handlers";

// Real Postgres (a throwaway database) and a real data dir (a temp one); the queue is a
// fake that records what it was handed.
let database: TestDatabase;
let db: Database;
let dataDir: string;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.handle.db;
  dataDir = await mkdtemp(path.join(tmpdir(), "gatecrusher-web-"));
});

afterAll(async () => {
  await database.drop();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(schema.playlists);
});

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface FakeQueueOptions {
  ready?: boolean;
  failEnqueue?: boolean;
}

function depsWith(options: FakeQueueOptions = {}, database_: Database = db) {
  const enqueued: string[][] = [];
  const deps: RunHandlerDeps = {
    db: database_,
    dataDir,
    log: silentLog,
    queue: {
      isReady: () => Promise.resolve(options.ready ?? true),
      enqueue: (jobIds) => {
        if (options.failEnqueue === true) return Promise.reject(new Error("Connection is closed."));
        enqueued.push([...jobIds]);
        return Promise.resolve();
      },
    },
  };
  return { deps, enqueued };
}

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

async function seedPlaylist(): Promise<string> {
  const { playlistId } = await savePlaylistIngest(db, {
    soundcloudUrl: "https://soundcloud.com/fixture-curator/sets/fixture-crate",
    source: "api_v2",
    soundcloudId: "9001",
    title: "Fixture Crate",
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
    ],
  });
  return playlistId;
}

async function jobIdsInPlaylistOrder(): Promise<string[]> {
  const [jobs, tracks] = await Promise.all([
    db.select().from(schema.jobs),
    db.select().from(schema.tracks),
  ]);
  const position = new Map(tracks.map((row) => [row.id, row.position]));
  return jobs
    .sort((a, b) => (position.get(a.trackId) ?? 0) - (position.get(b.trackId) ?? 0))
    .map((job) => job.id);
}

async function errorOf(response: Response) {
  return apiErrorSchema.parse(await response.json()).error;
}

describe("POST /api/playlists/:id/runs", () => {
  it("queues one job per native track, in playlist order, and hands them to the worker", async () => {
    const playlistId = await seedPlaylist();
    const { deps, enqueued } = depsWith();

    const response = await handleRunNative(playlistId, deps);

    expect(response.status).toBe(202);
    const body = runNativeResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ queued: 2, resumed: 0, alreadyDownloaded: 0, alreadyActive: 0 });
    expect(body.runId).not.toBeNull();
    expect(enqueued).toEqual([await jobIdsInPlaylistOrder()]);
    expect(await db.$count(schema.jobs)).toBe(2);
  });

  it("creates nothing new when clicked again, and hands the waiting jobs over again", async () => {
    const playlistId = await seedPlaylist();
    const { deps, enqueued } = depsWith();
    await handleRunNative(playlistId, deps);

    const response = await handleRunNative(playlistId, deps);

    expect(runNativeResponseSchema.parse(await response.json())).toEqual({
      runId: null,
      queued: 0,
      resumed: 0,
      alreadyDownloaded: 0,
      alreadyActive: 2,
    });
    expect(await db.$count(schema.jobs)).toBe(2);
    expect(enqueued).toHaveLength(2);
    expect([...(enqueued[1] ?? [])].sort()).toEqual([...(enqueued[0] ?? [])].sort());
  });

  it("skips downloaded tracks and retries paused ones", async () => {
    const playlistId = await seedPlaylist();
    const { deps, enqueued } = depsWith();
    await handleRunNative(playlistId, deps);
    const [downloadedId, pausedId] = await jobIdsInPlaylistOrder();
    if (downloadedId === undefined || pausedId === undefined) throw new Error("expected two jobs");
    for (const jobId of [downloadedId, pausedId]) {
      await startJob(db, { jobId, adapterId: "native-soundcloud", resumedOnOpenPage: false });
    }
    await completeJob(db, {
      jobId: downloadedId,
      download: {
        path: "downloads/fixture-crate/Fixture Artist - Track n1.mp3",
        sizeBytes: 2_000_000,
        mimeType: "audio/mpeg",
        kind: "audio",
        checksumSha256: "a".repeat(64),
      },
    });
    await parkJob(db, {
      jobId: pausedId,
      adapterId: "native-soundcloud",
      stepIndex: 1,
      stepName: "open-more",
      state: {},
      reason: "captcha",
      description: "Solve the captcha in the worker's browser window.",
      screenshotPath: `screenshots/x/${pausedId}/0002-open-more.png`,
      pageUrl: "https://soundcloud.com/fixture-artist/track-n2",
    });

    const response = await handleRunNative(playlistId, deps);

    expect(runNativeResponseSchema.parse(await response.json())).toEqual({
      runId: null,
      queued: 0,
      resumed: 1,
      alreadyDownloaded: 1,
      alreadyActive: 0,
    });
    expect(enqueued.at(-1)).toEqual([pausedId]);
  });

  it("starts nothing when Redis is unreachable", async () => {
    const playlistId = await seedPlaylist();

    const response = await handleRunNative(playlistId, depsWith({ ready: false }).deps);

    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: "queue_unavailable" });
    expect(await db.$count(schema.jobs)).toBe(0);
    expect(await db.$count(schema.runs)).toBe(0);
  });

  it("says so when the hand-over fails, and the next click hands the same jobs over", async () => {
    const playlistId = await seedPlaylist();

    const failed = await handleRunNative(playlistId, depsWith({ failEnqueue: true }).deps);

    expect(failed.status).toBe(503);
    expect((await errorOf(failed)).message).toContain("Click Run native tracks again");
    expect(await db.$count(schema.jobs)).toBe(2);

    const { deps, enqueued } = depsWith();
    const retried = await handleRunNative(playlistId, deps);
    expect(retried.status).toBe(202);
    expect([...(enqueued[0] ?? [])].sort()).toEqual((await jobIdsInPlaylistOrder()).sort());
    expect(await db.$count(schema.jobs)).toBe(2);
  });

  it.each(["00000000-0000-4000-8000-000000000000", "not-a-uuid", "1; drop table jobs"])(
    "answers 404 for playlist %s and enqueues nothing",
    async (id) => {
      const { deps, enqueued } = depsWith();

      const response = await handleRunNative(id, deps);

      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("not_found");
      expect(enqueued).toEqual([]);
    },
  );

  it("answers a typed 500 when the database is unreachable", async () => {
    const dead = createDb("postgres://nobody:nothing@127.0.0.1:1/nowhere", { max: 1 });
    try {
      const response = await handleRunNative(
        "00000000-0000-4000-8000-000000000000",
        depsWith({}, dead.db).deps,
      );

      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe("internal");
    } finally {
      await dead.close();
    }
  });
});

describe("GET /api/playlists/:id with run state", () => {
  const playlistDeps = () => ({
    db,
    log: silentLog,
    ingest: () => Promise.reject(new Error("not used")),
  });

  it("reports no job and no download for tracks that were never run", async () => {
    const playlistId = await seedPlaylist();

    const detail = playlistDetailResponseSchema.parse(
      await (await handleGetPlaylist(playlistId, playlistDeps())).json(),
    );

    expect(detail.tracks.map((item) => [item.job, item.download])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it("reports queued, running, paused and downloaded tracks", async () => {
    const playlistId = await seedPlaylist();
    await handleRunNative(playlistId, depsWith().deps);
    const [firstId, secondId] = await jobIdsInPlaylistOrder();
    if (firstId === undefined || secondId === undefined) throw new Error("expected two jobs");
    const [first] = await db.select().from(schema.jobs);
    const runId = first?.runId ?? "";

    let detail = playlistDetailResponseSchema.parse(
      await (await handleGetPlaylist(playlistId, playlistDeps())).json(),
    );
    expect(detail.tracks.map((item) => item.job?.status ?? null)).toEqual([
      "QUEUED",
      null,
      "QUEUED",
    ]);

    await startJob(db, {
      jobId: firstId,
      adapterId: "native-soundcloud",
      resumedOnOpenPage: false,
    });
    await recordStepStarted(db, { jobId: firstId, runId, stepIndex: 0, stepName: "open-track" });
    await startJob(db, {
      jobId: secondId,
      adapterId: "native-soundcloud",
      resumedOnOpenPage: false,
    });
    const screenshotPath = `screenshots/${runId}/${secondId}/0002-open-more.png`;
    await parkJob(db, {
      jobId: secondId,
      adapterId: "native-soundcloud",
      stepIndex: 1,
      stepName: "open-more",
      state: {},
      reason: "captcha",
      description: "Solve the captcha in the worker's browser window.",
      screenshotPath,
      pageUrl: "https://soundcloud.com/fixture-artist/track-n2",
    });

    detail = playlistDetailResponseSchema.parse(
      await (await handleGetPlaylist(playlistId, playlistDeps())).json(),
    );
    expect(detail.tracks[0]?.job).toMatchObject({ status: "RUNNING", stepName: "open-track" });
    expect(detail.tracks[2]?.job).toEqual({
      status: "WAITING_FOR_HUMAN",
      stepName: "open-more",
      needsHuman: {
        reason: "captcha",
        description: "Solve the captcha in the worker's browser window.",
        screenshotUrl: `/api/screenshots/${runId}/${secondId}/0002-open-more.png`,
      },
      manual: null,
      error: null,
    });

    await completeJob(db, {
      jobId: firstId,
      download: {
        path: "downloads/fixture-crate/Fixture Artist - Track n1.mp3",
        sizeBytes: 2_000_000,
        mimeType: "audio/mpeg",
        kind: "audio",
        checksumSha256: "a".repeat(64),
      },
    });
    const body = await (await handleGetPlaylist(playlistId, playlistDeps())).text();
    detail = playlistDetailResponseSchema.parse(JSON.parse(body));
    expect(detail.tracks[0]).toMatchObject({
      job: { status: "SUCCEEDED" },
      download: { fileName: "Fixture Artist - Track n1.mp3", sizeBytes: 2_000_000, kind: "audio" },
    });
    // Server-side paths stay on the server.
    expect(body).not.toContain("downloads/fixture-crate");
    expect(body).not.toContain(dataDir);
  });
});

describe("GET /api/screenshots/*", () => {
  const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  /** A parked job whose screenshot is recorded and, unless told otherwise, on disk. */
  async function recordedScreenshot(options: { onDisk?: boolean } = {}) {
    const playlistId = await seedPlaylist();
    await handleRunNative(playlistId, depsWith().deps);
    const [jobId] = await jobIdsInPlaylistOrder();
    if (jobId === undefined) throw new Error("expected a job");
    await startJob(db, { jobId, adapterId: "native-soundcloud", resumedOnOpenPage: false });
    const segments = [RUN, jobId, "0001-open-track.png"];
    await parkJob(db, {
      jobId,
      adapterId: "native-soundcloud",
      stepIndex: 0,
      stepName: "open-track",
      state: {},
      reason: "login_challenge",
      description: "Sign in with the burner account in the worker's browser window.",
      screenshotPath: ["screenshots", ...segments].join("/"),
      pageUrl: "https://soundcloud.com/signin",
    });
    if (options.onDisk !== false) {
      await mkdir(path.join(dataDir, "screenshots", RUN, jobId), { recursive: true });
      await writeFile(path.join(dataDir, "screenshots", ...segments), PNG);
    }
    return segments;
  }

  it("serves a recorded screenshot as a PNG", async () => {
    const segments = await recordedScreenshot();

    const response = await handleScreenshot(segments, depsWith().deps);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  });

  it("answers 404 for a screenshot that exists on disk but was never recorded", async () => {
    const segments = await recordedScreenshot();
    const stray = [segments[0] ?? "", segments[1] ?? "", "0009-stray.png"];
    await writeFile(path.join(dataDir, "screenshots", ...stray), PNG);

    const response = await handleScreenshot(stray, depsWith().deps);

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("answers 404 for a recorded screenshot that is no longer on disk", async () => {
    const segments = await recordedScreenshot({ onDisk: false });

    expect((await handleScreenshot(segments, depsWith().deps)).status).toBe(404);
  });

  it.each([
    ["a parent-directory segment", ["..", "..", ".env"]],
    ["an encoded traversal", ["%2e%2e", "%2e%2e", ".env"]],
    ["traversal inside a segment", [RUN, RUN, "../../../.env"]],
    ["a backslash traversal", [RUN, RUN, "..\\..\\secret.png"]],
    ["an absolute path", ["/etc", "passwd", "0001-x.png"]],
    ["too few segments", [RUN, "0001-open-track.png"]],
    ["too many segments", [RUN, RUN, "extra", "0001-open-track.png"]],
    ["a non-uuid directory", ["browser-profile", RUN, "0001-open-track.png"]],
    ["a file that is not a screenshot", [RUN, RUN, "Cookies"]],
    ["another extension", [RUN, RUN, "0001-open-track.html"]],
    ["nothing", []],
  ])("answers 404 for %s without touching the database or the disk", async (_label, segments) => {
    // A dead database proves the lookup is never reached for a malformed path.
    const dead = createDb("postgres://nobody:nothing@127.0.0.1:1/nowhere", { max: 1 });
    try {
      const response = await handleScreenshot(segments, depsWith({}, dead.db).deps);

      expect(response.status).toBe(404);
    } finally {
      await dead.close();
    }
  });
});
