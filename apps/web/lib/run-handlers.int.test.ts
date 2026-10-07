import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  completeJob,
  createDb,
  nextQueuedJobId,
  parkJob,
  recordStepStarted,
  savePlaylistIngest,
  saveSoundcloudAccount,
  schema,
  startJob,
  type ClassifiedTrack,
  type Database,
} from "@gatecrusher/db";
import { createTestDatabase, type TestDatabase } from "@gatecrusher/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  cancelRunResponseSchema,
  deletePlaylistResponseSchema,
  playlistDetailResponseSchema,
  runResponseSchema,
} from "./api-schemas";
import { handleGetPlaylist } from "./playlist-handlers";
import {
  handleArchive,
  handleCancelRun,
  handleDeletePlaylist,
  handleStartRun,
  handleScreenshot,
  type RunHandlerDeps,
} from "./run-handlers";

// Real Postgres (a throwaway database) and a real data dir (a temp one). The queue is the
// jobs table, so "handed to the worker" means a QUEUED job row.
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
  await db.delete(schema.soundcloudAccount);
  await saveSoundcloudAccount(db, {
    oauthToken: "2-290123-123456789-aBcDeFgHiJkLmN",
    soundcloudUserId: "290123",
    username: "burner-digger",
  });
});

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function depsWith(database_: Database = db) {
  const deps: RunHandlerDeps = { db: database_, dataDir, log: silentLog };
  return { deps };
}

async function statusOf(jobId: string) {
  const jobs = await db.select().from(schema.jobs);
  return jobs.find((job) => job.id === jobId)?.status;
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
  it("queues one job per track, native or not, in playlist order, for the worker", async () => {
    const playlistId = await seedPlaylist();
    const { deps } = depsWith();

    const response = await handleStartRun(playlistId, deps);

    expect(response.status).toBe(202);
    const body = runResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ queued: 3, resumed: 0, alreadyDownloaded: 0, alreadyActive: 0 });
    expect(body.runId).not.toBeNull();
    expect(await db.$count(schema.jobs)).toBe(3);
    expect(await nextQueuedJobId(db)).toBe((await jobIdsInPlaylistOrder())[0]);
  });

  it("creates nothing new when clicked again; the queued jobs stay queued", async () => {
    const playlistId = await seedPlaylist();
    const { deps } = depsWith();
    await handleStartRun(playlistId, deps);

    const response = await handleStartRun(playlistId, deps);

    expect(runResponseSchema.parse(await response.json())).toEqual({
      runId: null,
      queued: 0,
      resumed: 0,
      alreadyDownloaded: 0,
      alreadyActive: 3,
    });
    expect(await db.$count(schema.jobs)).toBe(3);
    for (const jobId of await jobIdsInPlaylistOrder()) expect(await statusOf(jobId)).toBe("QUEUED");
  });

  it("skips downloaded tracks and retries paused ones", async () => {
    const playlistId = await seedPlaylist();
    const { deps } = depsWith();
    await handleStartRun(playlistId, deps);
    const [downloadedId, pausedId, queuedId] = await jobIdsInPlaylistOrder();
    if (downloadedId === undefined || pausedId === undefined || queuedId === undefined) {
      throw new Error("expected three jobs");
    }
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

    const response = await handleStartRun(playlistId, deps);

    expect(runResponseSchema.parse(await response.json())).toEqual({
      runId: null,
      queued: 0,
      resumed: 1,
      alreadyDownloaded: 1,
      alreadyActive: 1,
    });
    expect(await statusOf(pausedId)).toBe("QUEUED");
    expect(await statusOf(queuedId)).toBe("QUEUED");
  });

  it("starts nothing, and says what to do, when no SoundCloud account is connected", async () => {
    const playlistId = await seedPlaylist();
    await db.delete(schema.soundcloudAccount);
    const { deps } = depsWith();

    const response = await handleStartRun(playlistId, deps);

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("soundcloud_not_connected");
    expect(error.message).toContain("Connect a SoundCloud account first");
    expect(await db.$count(schema.jobs)).toBe(0);
    expect(await db.$count(schema.runs)).toBe(0);
  });

  it.each(["00000000-0000-4000-8000-000000000000", "not-a-uuid", "1; drop table jobs"])(
    "answers 404 for playlist %s and queues nothing",
    async (id) => {
      const { deps } = depsWith();

      const response = await handleStartRun(id, deps);

      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("not_found");
      expect(await db.$count(schema.jobs)).toBe(0);
    },
  );

  it("answers a typed 500 when the database is unreachable", async () => {
    const dead = createDb("postgres://nobody:nothing@127.0.0.1:1/nowhere", { max: 1 });
    try {
      const response = await handleStartRun(
        "00000000-0000-4000-8000-000000000000",
        depsWith(dead.db).deps,
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
    await handleStartRun(playlistId, depsWith().deps);
    // The two native tracks; the gate track between them stays queued.
    const [firstId, , secondId] = await jobIdsInPlaylistOrder();
    if (firstId === undefined || secondId === undefined) throw new Error("expected two jobs");
    const [first] = await db.select().from(schema.jobs);
    const runId = first?.runId ?? "";

    let detail = playlistDetailResponseSchema.parse(
      await (await handleGetPlaylist(playlistId, playlistDeps())).json(),
    );
    expect(detail.tracks.map((item) => item.job?.status ?? null)).toEqual([
      "QUEUED",
      "QUEUED",
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

const SONG = Buffer.from("ID3 fake audio ".repeat(100_000));

/** A playlist with its first native track downloaded and the file on disk. */
async function downloadedPlaylist() {
  const playlistId = await seedPlaylist();
  await handleStartRun(playlistId, depsWith().deps);
  const [jobId] = await jobIdsInPlaylistOrder();
  if (jobId === undefined) throw new Error("expected a job");
  await startJob(db, { jobId, adapterId: "yt-dlp", resumedOnOpenPage: false });
  const relative = "downloads/fixture-crate/Fixture Artist - Track n1.mp3";
  await mkdir(path.join(dataDir, "downloads", "fixture-crate"), { recursive: true });
  await writeFile(path.join(dataDir, relative), SONG);
  await completeJob(db, {
    jobId,
    download: {
      path: relative,
      sizeBytes: SONG.length,
      mimeType: "audio/mpeg",
      kind: "audio",
      checksumSha256: "a".repeat(64),
    },
  });
  return playlistId;
}

describe("GET /api/playlists/:id/archive", () => {
  it("streams the playlist's files as one stored zip", async () => {
    const playlistId = await downloadedPlaylist();

    const response = await handleArchive(playlistId, depsWith().deps);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toContain('filename="fixture-crate.zip"');
    const zip = Buffer.from(await response.arrayBuffer());
    // Local header, the file's name, the bytes themselves, and an end record.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from("Fixture Artist - Track n1.mp3"))).toBe(true);
    expect(zip.includes(SONG.subarray(0, 64))).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.length).toBeGreaterThan(SONG.length);
  });

  it("answers 404 when nothing has been downloaded yet", async () => {
    const playlistId = await seedPlaylist();

    const response = await handleArchive(playlistId, depsWith().deps);

    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toContain("Nothing has been downloaded");
  });

  it("holds only the ticked tracks when some are named", async () => {
    const playlistId = await downloadedPlaylist();
    const rows = await db.select().from(schema.tracks);
    const downloaded = rows.find((row) => row.soundcloudId === "n1");
    const notDownloaded = rows.find((row) => row.soundcloudId === "n2");
    if (downloaded === undefined || notDownloaded === undefined) throw new Error("fixture");

    const both = await handleArchive(
      playlistId,
      depsWith().deps,
      `${downloaded.id},${notDownloaded.id}`,
    );
    expect(both.status).toBe(200);
    const zip = Buffer.from(await both.arrayBuffer());
    expect(zip.includes(Buffer.from("Fixture Artist - Track n1.mp3"))).toBe(true);

    // Ticked tracks without a file give nothing to zip.
    const none = await handleArchive(playlistId, depsWith().deps, notDownloaded.id);
    expect(none.status).toBe(404);
    expect((await errorOf(none)).message).toContain("None of the ticked tracks");
  });

  it.each(["", "not-an-id", "00000000-0000-4000-8000-000000000000,"])(
    "rejects the tracks field %j",
    async (field) => {
      const playlistId = await downloadedPlaylist();

      const response = await handleArchive(playlistId, depsWith().deps, field);

      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("invalid_request");
    },
  );

  it.each(["00000000-0000-4000-8000-000000000000", "not-a-uuid"])(
    "answers 404 for playlist %s",
    async (id) => {
      expect((await handleArchive(id, depsWith().deps)).status).toBe(404);
    },
  );

  it("refuses to serve a recorded path outside the downloads folder", async () => {
    const playlistId = await downloadedPlaylist();
    await db.update(schema.downloads).set({ filePath: "../.env" });

    const response = await handleArchive(playlistId, depsWith().deps);

    expect(response.status).toBe(500);
  });
});

describe("GET /api/screenshots/*", () => {
  const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  /** A parked job whose screenshot is recorded and, unless told otherwise, on disk. */
  async function recordedScreenshot(options: { onDisk?: boolean } = {}) {
    const playlistId = await seedPlaylist();
    await handleStartRun(playlistId, depsWith().deps);
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
      const response = await handleScreenshot(segments, depsWith(dead.db).deps);

      expect(response.status).toBe(404);
    } finally {
      await dead.close();
    }
  });
});

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

describe("DELETE /api/playlists/:id/runs", () => {
  it("cancels the queued tracks and leaves the running one to finish", async () => {
    const playlistId = await seedPlaylist();
    await handleStartRun(playlistId, depsWith().deps);
    const [runningId] = await jobIdsInPlaylistOrder();
    await startJob(db, { jobId: runningId ?? "", adapterId: "yt-dlp", resumedOnOpenPage: false });

    const response = await handleCancelRun(playlistId, depsWith().deps);

    expect(response.status).toBe(200);
    expect(cancelRunResponseSchema.parse(await response.json())).toEqual({
      cancelled: 2,
      running: 1,
    });
    const statuses = (await db.select().from(schema.jobs)).map((job) => job.status).sort();
    expect(statuses).toEqual(["CANCELLED", "CANCELLED", "RUNNING"]);
  });

  it("lets Download tracks queue the cancelled tracks again", async () => {
    const playlistId = await seedPlaylist();
    const { deps } = depsWith();
    await handleStartRun(playlistId, deps);
    await handleCancelRun(playlistId, deps);

    const again = runResponseSchema.parse(await (await handleStartRun(playlistId, deps)).json());

    expect(again.queued).toBe(3);
  });

  it.each(["00000000-0000-4000-8000-000000000000", "not-a-uuid"])(
    "answers 404 for playlist %s",
    async (id) => {
      expect((await handleCancelRun(id, depsWith().deps)).status).toBe(404);
    },
  );
});

describe("DELETE /api/playlists/:id", () => {
  it("deletes the playlist, its history and its files, and the folder they leave empty", async () => {
    const playlistId = await downloadedPlaylist();
    const folder = path.join(dataDir, "downloads", "fixture-crate");

    const response = await handleDeletePlaylist(playlistId, depsWith().deps);

    expect(response.status).toBe(200);
    expect(deletePlaylistResponseSchema.parse(await response.json())).toEqual({
      deletedFiles: 1,
      freedBytes: SONG.length,
    });
    expect(await db.$count(schema.playlists)).toBe(0);
    expect(await db.$count(schema.jobs)).toBe(0);
    expect(await exists(folder)).toBe(false);
  });

  it("keeps files in the folder that the app did not record", async () => {
    const playlistId = await downloadedPlaylist();
    const stray = path.join(dataDir, "downloads", "fixture-crate", "mine.wav");
    await writeFile(stray, "not recorded");

    await handleDeletePlaylist(playlistId, depsWith().deps);

    expect(await exists(stray)).toBe(true);
    await rm(stray);
  });

  it("is refused, and changes nothing, while one of its tracks is downloading", async () => {
    const playlistId = await downloadedPlaylist();
    const [, secondId] = await jobIdsInPlaylistOrder();
    await startJob(db, { jobId: secondId ?? "", adapterId: "yt-dlp", resumedOnOpenPage: false });

    const response = await handleDeletePlaylist(playlistId, depsWith().deps);

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({ code: "playlist_busy" });
    expect(await db.$count(schema.playlists)).toBe(1);
    expect(
      await exists(path.join(dataDir, "downloads/fixture-crate/Fixture Artist - Track n1.mp3")),
    ).toBe(true);
  });

  it("never deletes a recorded path outside the downloads folder", async () => {
    const playlistId = await downloadedPlaylist();
    const outside = path.join(dataDir, "keep-me.txt");
    await writeFile(outside, "not a download");
    await db.update(schema.downloads).set({ filePath: "keep-me.txt" });

    const response = await handleDeletePlaylist(playlistId, depsWith().deps);

    expect(deletePlaylistResponseSchema.parse(await response.json()).deletedFiles).toBe(0);
    expect(await exists(outside)).toBe(true);
    await rm(path.join(dataDir, "downloads", "fixture-crate"), { recursive: true, force: true });
  });

  it("deletes a playlist whose files were already removed by hand", async () => {
    const playlistId = await downloadedPlaylist();
    await rm(path.join(dataDir, "downloads", "fixture-crate"), { recursive: true });

    const response = await handleDeletePlaylist(playlistId, depsWith().deps);

    expect(response.status).toBe(200);
    expect(deletePlaylistResponseSchema.parse(await response.json())).toEqual({
      deletedFiles: 0,
      freedBytes: 0,
    });
  });

  it.each(["00000000-0000-4000-8000-000000000000", "not-a-uuid"])(
    "answers 404 for playlist %s",
    async (id) => {
      expect((await handleDeletePlaylist(id, depsWith().deps)).status).toBe(404);
    },
  );
});
