import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { schema, startJob, startNativeRun } from "@gatecrusher/db";
import { fakeHtmlPage, fakeMp3, fakeWav } from "@gatecrusher/gates/testing";
import { asc, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner } from "./process-runner.ts";
import { createWorkerTestBed, type WorkerTestBed } from "./testing.ts";
import {
  classifyYtDlpFailure,
  processYtDlpJob,
  RATE_LIMIT_BACK_OFF_MS,
  ytDlpArgs,
  type YtDlpJobDeps,
} from "./ytdlp-job.ts";

// The real job, verification, file store and Postgres; yt-dlp is a fake that behaves
// like the real one at the boundary: it writes a file at the output template (with its
// own extension) and prints the path, or fails with yt-dlp's wording on stderr.
const log = pino({ level: "silent" });

let bed: WorkerTestBed;

beforeAll(async () => {
  bed = await createWorkerTestBed();
});

afterAll(async () => {
  await bed.close();
});

type FakeBehaviour =
  | { deliver: Buffer; extension: string }
  | { fail: Omit<Extract<ProcessResult, { ok: false }>, "stdout"> }
  | { deliverNothing: true };

function fakeYtDlp(behaviour: FakeBehaviour): ProcessRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_command, args) => {
      calls.push([...args]);
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

async function oneJob() {
  const { playlistId, trackIds } = await bed.seedPlaylist([{ name: "track" }]);
  const run = await startNativeRun(bed.db, playlistId);
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
  it("asks for the uploader's download only, and never a stream", () => {
    const args = ytDlpArgs("/tmp/x.%(ext)s", "https://soundcloud.com/a/b");

    expect(args.slice(args.indexOf("--format"), args.indexOf("--format") + 2)).toEqual([
      "--format",
      "download",
    ]);
    // No stream format anywhere in the options (the URL itself comes after "--").
    expect(args.slice(0, args.indexOf("--")).join(" ")).not.toMatch(/best|http|hls|mp3/);
    expect(args.slice(-2)).toEqual(["--", "https://soundcloud.com/a/b"]);
    expect(args).toContain("--no-playlist");
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

  it("never opens a browser", async () => {
    const { jobId } = await oneJob();

    await processYtDlpJob(jobId, depsWith(fakeYtDlp({ deliver: fakeMp3(), extension: "mp3" })));

    expect(bed.context()).toBeUndefined();
  });
});
