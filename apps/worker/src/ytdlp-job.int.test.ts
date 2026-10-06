import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cancelPlaylistRun,
  saveSoundcloudAccount,
  schema,
  startJob,
  startPlaylistRun,
} from "@gatecrusher/db";
import type { TrackClassification } from "@gatecrusher/core";
import { fakeHtmlPage, fakeM4a, fakeMp3, fakeWav } from "@gatecrusher/gates/testing";
import { and, asc, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cookieDir } from "./cookie-file.ts";
import type { ProcessResult, ProcessRunner } from "./process-runner.ts";
import { createWorkerTestBed, type WorkerTestBed } from "./testing.ts";
import {
  classifyYtDlpFailure,
  NOT_CONNECTED_MESSAGE,
  processYtDlpJob,
  RATE_LIMIT_BACK_OFF_MS,
  sourceFor,
  ytDlpArgs,
  type YtDlpJobDeps,
} from "./ytdlp-job.ts";

// The real job, verification, file store and Postgres; yt-dlp is a fake that behaves
// like the real one at the boundary: it writes a file at the output template (with its
// own extension) and prints the path, or fails with yt-dlp's wording on stderr.
const log = pino({ level: "silent" });

// Made-up value in the shape SoundCloud uses; never a real token.
const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";

let bed: WorkerTestBed;

beforeAll(async () => {
  bed = await createWorkerTestBed();
});

beforeEach(async () => {
  await saveSoundcloudAccount(bed.db, {
    oauthToken: TOKEN,
    soundcloudUserId: "290123",
    username: "burner-digger",
  });
});

afterAll(async () => {
  await bed.close();
});

type FakeBehaviour =
  | { deliver: Buffer; extension: string }
  | { fail: Omit<Extract<ProcessResult, { ok: false }>, "stdout"> }
  | { deliverNothing: true };

interface FakeYtDlp extends ProcessRunner {
  calls: string[][];
  /** What the `--cookies` file held while yt-dlp ran. */
  cookieFiles: { path: string; content: string }[];
}

function fakeYtDlp(behaviour: FakeBehaviour): FakeYtDlp {
  const calls: string[][] = [];
  const cookieFiles: FakeYtDlp["cookieFiles"] = [];
  return {
    calls,
    cookieFiles,
    run: async (_command, args) => {
      calls.push([...args]);
      const cookies = args[args.indexOf("--cookies") + 1];
      if (cookies !== undefined) {
        cookieFiles.push({ path: cookies, content: await readFile(cookies, "utf8") });
      }
      if ("fail" in behaviour) return { ...behaviour.fail, stdout: "" };
      if ("deliverNothing" in behaviour) return { ok: true, stdout: "", stderr: "" };
      const template = args[args.indexOf("--output") + 1];
      if (template === undefined) throw new Error("fake yt-dlp: no --output");
      const file = template.replace("%(ext)s", behaviour.extension);
      await writeFile(file, behaviour.deliver);
      return { ok: true, stdout: `${file}\n`, stderr: "" };
    },
  };
}

function depsWith(runner: ProcessRunner): YtDlpJobDeps {
  return {
    db: bed.db,
    log,
    runner,
    command: "yt-dlp",
    dataDir: bed.dataDir,
    minDownloadBytes: 1_048_576,
  };
}

async function oneJob(classification: TrackClassification = "native") {
  const { playlistId, trackIds } = await bed.seedPlaylist([{ name: "track", classification }]);
  const run = await startPlaylistRun(bed.db, playlistId);
  if (!run.ok || run.runId === null) throw new Error("expected a run");
  const [jobId] = run.newJobIds;
  if (jobId === undefined) throw new Error("expected a job");
  return { playlistId, trackId: trackIds[0] ?? "", runId: run.runId, jobId };
}

async function jobOf(jobId: string) {
  const [job] = await bed.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (job === undefined) throw new Error("job missing");
  return job;
}

async function eventTypes(jobId: string): Promise<string[]> {
  const rows = await bed.db
    .select({ type: schema.events.type })
    .from(schema.events)
    .where(eq(schema.events.jobId, jobId))
    .orderBy(asc(schema.events.id));
  return rows.map((row) => row.type);
}

async function playlistFiles(jobId: string): Promise<string[]> {
  const job = await jobOf(jobId);
  const [row] = await bed.db
    .select({ url: schema.playlists.soundcloudUrl })
    .from(schema.playlists)
    .innerJoin(schema.tracks, eq(schema.tracks.playlistId, schema.playlists.id))
    .where(eq(schema.tracks.id, job.trackId));
  const slug = row?.url.split("/").at(-1) ?? "missing";
  try {
    return await readdir(path.join(bed.dataDir, "downloads", slug));
  } catch {
    // Not created: nothing was written there.
    return [];
  }
}

describe("ytDlpArgs", () => {
  const args = (source: "download" | "stream") =>
    ytDlpArgs("/tmp/x.%(ext)s", "https://soundcloud.com/a/b", "/tmp/cookies.txt", source);

  it("asks for the uploader's download only, and never a stream, for a native track", () => {
    const download = args("download");

    expect(download.slice(download.indexOf("--format"), download.indexOf("--format") + 2)).toEqual([
      "--format",
      "download",
    ]);
    // No stream format anywhere in the options (the URL itself comes after "--").
    expect(download.slice(0, download.indexOf("--")).join(" ")).not.toMatch(/best|http|hls|mp3/);
    expect(download).not.toContain("--embed-thumbnail");
    expect(download.slice(-2)).toEqual(["--", "https://soundcloud.com/a/b"]);
  });

  it("falls back to the best stream, with tags and artwork, for every other track", () => {
    const stream = args("stream");

    expect(stream.slice(stream.indexOf("--format"), stream.indexOf("--format") + 2)).toEqual([
      "--format",
      "download/bestaudio",
    ]);
    expect(stream).toContain("--embed-metadata");
    expect(stream).toContain("--embed-thumbnail");
    // Never re-encoded: the file is kept as SoundCloud serves it.
    expect(stream).not.toContain("--extract-audio");
    expect(stream).not.toContain("--audio-format");
    expect(stream.slice(-2)).toEqual(["--", "https://soundcloud.com/a/b"]);
  });

  it.each(["download", "stream"] as const)(
    "signs in through the cookie file and keeps the login warnings (%s)",
    (source) => {
      const list = args(source);

      expect(list.slice(list.indexOf("--cookies"), list.indexOf("--cookies") + 2)).toEqual([
        "--cookies",
        "/tmp/cookies.txt",
      ]);
      expect(list).not.toContain("--no-warnings");
      expect(list).not.toContain("--password");
      expect(list).toContain("--no-playlist");
    },
  );
});

describe("sourceFor", () => {
  it("downloads native tracks only as the uploader's file, and streams the rest", () => {
    expect(sourceFor("native")).toBe("download");
    expect(sourceFor("gate")).toBe("stream");
    expect(sourceFor("buy")).toBe("stream");
    expect(sourceFor("none")).toBe("stream");
  });
});

describe("classifyYtDlpFailure", () => {
  it.each([
    ["ERROR: [soundcloud] 123: Requested format is not available", "download_not_offered"],
    [
      "ERROR: [soundcloud] abc: Unable to download JSON metadata: HTTP Error 404: Not Found",
      "track_gone",
    ],
    ["ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests", "rate_limited"],
    ["ERROR: unable to download video data: HTTP Error 403: Forbidden", "rate_limited"],
    ["ERROR: something else entirely", "other"],
    ["ERROR: [soundcloud] 2171144808: This video is DRM protected", "drm_protected"],
    [
      "WARNING: [soundcloud] 1: hls_aac format not found\nERROR: [soundcloud] 1: This video is DRM protected",
      "drm_protected",
    ],
    [
      "ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location",
      "ffmpeg_missing",
    ],
    [
      "WARNING: ffmpeg not found. The downloaded format may not be the best available.\nERROR: [soundcloud] 1: This video is DRM protected",
      "drm_protected",
    ],
    [
      "WARNING: [soundcloud] Provided authorization token is invalid. Continuing as guest\nERROR: [soundcloud] 123: Requested format is not available",
      "login_rejected",
    ],
    [
      "WARNING: [soundcloud] Original download format is only available for registered users. Use --cookies\nERROR: [soundcloud] 123: Requested format is not available",
      "login_required",
    ],
    [
      "WARNING: [soundcloud] Unable to download JSON metadata: HTTP Error 404: Not Found\nERROR: [soundcloud] 123: Requested format is not available",
      "download_not_offered",
    ],
  ])("%s -> %s", (detail, kind) => {
    expect(classifyYtDlpFailure({ kind: "failed", detail }).kind).toBe(kind);
  });

  it("passes through not-installed and timeouts", () => {
    expect(classifyYtDlpFailure({ kind: "not_installed", detail: "x" }).kind).toBe("not_installed");
    expect(classifyYtDlpFailure({ kind: "timeout", detail: "x" }).kind).toBe("timeout");
  });
});

describe("processYtDlpJob", () => {
  it("downloads the uploader's file, verifies it, stores it and records everything", async () => {
    const { jobId, runId, trackId } = await oneJob();
    const runner = fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" });

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome).toEqual({ result: { jobId, outcome: "succeeded" } });
    expect(await jobOf(jobId)).toMatchObject({ status: "SUCCEEDED", adapterId: "yt-dlp" });
    const [download] = await bed.db
      .select()
      .from(schema.downloads)
      .where(eq(schema.downloads.jobId, jobId));
    expect(download).toMatchObject({ trackId, mimeType: "audio/mpeg", kind: "audio" });
    expect(download?.filePath).toMatch(/\/Fixture Artist - Fixture Track 1\.mp3$/);
    expect(await playlistFiles(jobId)).toEqual(["Fixture Artist - Fixture Track 1.mp3"]);
    expect(await eventTypes(jobId)).toEqual([
      "job_started",
      "step_started",
      "step_finished",
      "job_succeeded",
    ]);
    // The exact yt-dlp invocation: the track's own URL, the download format, no browser.
    const [args] = runner.calls;
    expect(args?.at(-1)).toBe(bed.server.pageUrl("track"));
    expect(args).toContain("download");
    // Signed in through a cookie file holding the token, never through an argument.
    expect(args?.join(" ")).not.toContain(TOKEN);
    expect(runner.cookieFiles).toHaveLength(1);
    expect(runner.cookieFiles[0]?.content).toContain(`\toauth_token\t${TOKEN}\n`);
    expect(path.dirname(runner.cookieFiles[0]?.path ?? "")).toBe(cookieDir(bed.dataDir));
    const [run] = await bed.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run).toMatchObject({ status: "FINISHED", succeededCount: 1 });
  });

  it("names the file by what it is, not by what yt-dlp called it", async () => {
    const { jobId } = await oneJob();

    await processYtDlpJob(jobId, depsWith(fakeYtDlp({ deliver: fakeWav(), extension: "mp3" })));

    expect(await playlistFiles(jobId)).toEqual(["Fixture Artist - Fixture Track 1.wav"]);
  });

  it("marks a track whose download is no longer offered manual as file gone", async () => {
    const { jobId } = await oneJob();
    const runner = fakeYtDlp({
      fail: { ok: false, kind: "failed", detail: "ERROR: Requested format is not available" },
    });

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome.result.outcome).toBe("manual");
    expect(await jobOf(jobId)).toMatchObject({
      status: "MANUAL",
      manualReason: "file_gone",
      manualLink: bed.server.pageUrl("track"),
    });
    expect(await eventTypes(jobId)).toEqual([
      "job_started",
      "step_started",
      "step_finished",
      "job_manual",
    ]);
  });

  it("streams a track that is not native into the same folder, with its step named", async () => {
    const { jobId, trackId } = await oneJob("buy");
    const runner = fakeYtDlp({ deliver: fakeM4a(), extension: "m4a" });

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome).toEqual({ result: { jobId, outcome: "succeeded" } });
    const [download] = await bed.db
      .select()
      .from(schema.downloads)
      .where(eq(schema.downloads.jobId, jobId));
    expect(download).toMatchObject({ trackId, mimeType: "audio/mp4", kind: "audio" });
    expect(await playlistFiles(jobId)).toEqual(["Fixture Artist - Fixture Track 1.m4a"]);
    const [args] = runner.calls;
    expect(args).toContain("download/bestaudio");
    expect(args).toContain("--embed-thumbnail");
    expect(args?.join(" ")).not.toContain(TOKEN);
    const [step] = await bed.db
      .select({ stepName: schema.events.stepName })
      .from(schema.events)
      .where(and(eq(schema.events.jobId, jobId), eq(schema.events.type, "step_started")));
    expect(step?.stepName).toBe("yt-dlp-stream");
  });

  it("keeps the audio, not the artwork yt-dlp left beside it", async () => {
    const { jobId } = await oneJob("none");
    const runner: ProcessRunner = {
      run: async (_command, args) => {
        const template = args[args.indexOf("--output") + 1] ?? "";
        // A leftover cover sorts before the audio file.
        await writeFile(template.replace("%(ext)s", "jpg"), Buffer.alloc(10));
        await writeFile(template.replace("%(ext)s", "m4a"), fakeM4a());
        return { ok: true, stdout: "", stderr: "" };
      },
    };

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome.result.outcome).toBe("succeeded");
    expect(await playlistFiles(jobId)).toContain("Fixture Artist - Fixture Track 1.m4a");
  });

  it("marks a DRM-only track manual, never trying to get around it", async () => {
    const { jobId } = await oneJob("gate");
    const runner = fakeYtDlp({
      fail: {
        ok: false,
        kind: "failed",
        detail: "ERROR: [soundcloud] 2171144808: This video is DRM protected",
      },
    });

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome.result.outcome).toBe("manual");
    expect(runner.calls).toHaveLength(1);
    expect(await jobOf(jobId)).toMatchObject({
      status: "MANUAL",
      manualReason: "drm_protected",
      manualLink: bed.server.pageUrl("track"),
    });
    expect(await playlistFiles(jobId)).toEqual([]);
  });

  it("fails (retryable) and says to install ffmpeg when embedding needs it", async () => {
    const { jobId } = await oneJob("buy");
    const runner = fakeYtDlp({
      fail: {
        ok: false,
        kind: "failed",
        detail:
          "ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location",
      },
    });

    await processYtDlpJob(jobId, depsWith(runner));

    const job = await jobOf(jobId);
    expect(job).toMatchObject({ status: "FAILED", manualReason: null });
    expect(job.error).toContain("ffmpeg");
  });

  it("deletes the login cookie file once the job is over, whatever the outcome", async () => {
    const first = await oneJob();
    await processYtDlpJob(
      first.jobId,
      depsWith(fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" })),
    );
    const second = await oneJob();
    await processYtDlpJob(
      second.jobId,
      depsWith(fakeYtDlp({ fail: { ok: false, kind: "timeout", detail: "x" } })),
    );

    const left = (await readdir(cookieDir(bed.dataDir))).filter((name) =>
      name.startsWith("soundcloud-cookies-"),
    );
    expect(left).toEqual([]);
  });

  it("fails without calling yt-dlp when no SoundCloud account is connected", async () => {
    await bed.db.delete(schema.soundcloudAccount);
    const { jobId } = await oneJob();
    const runner = fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" });

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome).toEqual({ result: { jobId, outcome: "failed" } });
    expect(runner.calls).toHaveLength(0);
    expect(await jobOf(jobId)).toMatchObject({ status: "FAILED", error: NOT_CONNECTED_MESSAGE });
  });

  it.each([
    [
      "rejected",
      "WARNING: [soundcloud] Provided authorization token is invalid. Continuing as guest\nERROR: [soundcloud] 1: Requested format is not available",
      "did not accept the saved login",
    ],
    [
      "not used",
      "WARNING: [soundcloud] Original download format is only available for registered users.\nERROR: [soundcloud] 1: Requested format is not available",
      "treated the download as not signed in",
    ],
  ])(
    "fails (retryable, not manual) when the login was %s, and says to reconnect",
    async (_label, stderr, message) => {
      const { jobId } = await oneJob();
      const runner = fakeYtDlp({ fail: { ok: false, kind: "failed", detail: stderr } });

      const outcome = await processYtDlpJob(jobId, depsWith(runner));

      expect(outcome).toEqual({ result: { jobId, outcome: "failed" } });
      const job = await jobOf(jobId);
      expect(job).toMatchObject({ status: "FAILED", manualReason: null });
      expect(job.error).toContain(message);
      expect(job.error).toContain("Connect SoundCloud again in Settings");
    },
  );

  it("marks a removed track manual as a dead link", async () => {
    const { jobId } = await oneJob();
    const runner = fakeYtDlp({
      fail: { ok: false, kind: "failed", detail: "ERROR: HTTP Error 404: Not Found" },
    });

    await processYtDlpJob(jobId, depsWith(runner));

    expect(await jobOf(jobId)).toMatchObject({ status: "MANUAL", manualReason: "dead_link" });
  });

  it("fails and asks the worker to back off when SoundCloud pushes back", async () => {
    const { jobId } = await oneJob();
    const runner = fakeYtDlp({
      fail: { ok: false, kind: "failed", detail: "ERROR: HTTP Error 429: Too Many Requests" },
    });

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome).toEqual({
      result: { jobId, outcome: "failed" },
      backOffMs: RATE_LIMIT_BACK_OFF_MS,
    });
    const job = await jobOf(jobId);
    expect(job.status).toBe("FAILED");
    expect(job.error).toContain("rate limited");
  });

  it("fails clearly when yt-dlp is not installed", async () => {
    const { jobId } = await oneJob();
    const runner = fakeYtDlp({ fail: { ok: false, kind: "not_installed", detail: "no" } });

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome.backOffMs).toBeUndefined();
    expect((await jobOf(jobId)).error).toContain("yt-dlp is not installed");
  });

  it.each([
    ["an HTML page", fakeHtmlPage()],
    ["a tiny file", fakeMp3(2_048)],
  ])("never marks success for %s, and leaves nothing behind", async (_label, body) => {
    const { jobId } = await oneJob();

    const outcome = await processYtDlpJob(
      jobId,
      depsWith(fakeYtDlp({ deliver: body, extension: "mp3" })),
    );

    expect(outcome.result.outcome).toBe("failed");
    expect(await jobOf(jobId)).toMatchObject({ status: "FAILED" });
    expect(await bed.db.$count(schema.downloads, eq(schema.downloads.jobId, jobId))).toBe(0);
    expect(await playlistFiles(jobId)).toEqual([]);
  });

  it("fails when yt-dlp claims success but wrote nothing", async () => {
    const { jobId } = await oneJob();

    await processYtDlpJob(jobId, depsWith(fakeYtDlp({ deliverNothing: true })));

    expect((await jobOf(jobId)).error).toContain("wrote no file");
  });

  it("skips a job that is not runnable any more, without calling yt-dlp", async () => {
    const { jobId } = await oneJob();
    const runner = fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" });
    await processYtDlpJob(jobId, depsWith(runner));

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome.result.outcome).toBe("skipped");
    expect(runner.calls).toHaveLength(1);
  });

  it("runs a job a dead worker left RUNNING, and says it was recovered", async () => {
    const { jobId } = await oneJob();
    await startJob(bed.db, { jobId, adapterId: "yt-dlp", resumedOnOpenPage: false });

    const outcome = await processYtDlpJob(
      jobId,
      depsWith(fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" })),
    );

    expect(outcome.result.outcome).toBe("succeeded");
    expect((await eventTypes(jobId)).slice(0, 3)).toEqual([
      "job_started",
      "recovered_after_restart",
      "job_started",
    ]);
  });

  it("skips a job that no longer exists (its playlist was deleted), without calling yt-dlp", async () => {
    const runner = fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" });
    const jobId = "00000000-0000-4000-8000-000000000000";

    expect(await processYtDlpJob(jobId, depsWith(runner))).toEqual({
      result: { jobId, outcome: "skipped" },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("skips a cancelled job without calling yt-dlp", async () => {
    const { jobId, playlistId } = await oneJob();
    await cancelPlaylistRun(bed.db, playlistId);
    const runner = fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" });

    const outcome = await processYtDlpJob(jobId, depsWith(runner));

    expect(outcome.result.outcome).toBe("skipped");
    expect(runner.calls).toHaveLength(0);
    expect((await jobOf(jobId)).status).toBe("CANCELLED");
  });

  it("never opens a browser", async () => {
    const { jobId } = await oneJob();

    await processYtDlpJob(jobId, depsWith(fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" })));

    expect(bed.context()).toBeUndefined();
  });
});
