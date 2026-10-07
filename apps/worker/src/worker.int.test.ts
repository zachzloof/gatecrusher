import { writeFile } from "node:fs/promises";
import { parseEnv, workerEnvSchema, type WorkerEnv } from "@gatecrusher/core";
import {
  readWorkerHeartbeat,
  saveSoundcloudAccount,
  schema,
  startPlaylistRun,
} from "@gatecrusher/db";
import { fakeMp3 } from "@gatecrusher/gates/testing";
import { asc, eq, inArray } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "./process-runner.ts";
import { createWorkerTestBed, type WorkerTestBed } from "./testing.ts";
import { startWorker, type RunningWorker, type StartWorkerOptions } from "./worker.ts";

// The whole worker against a throwaway database: the job loop, the heartbeat, and the
// real processors — yt-dlp replaced by a fake that writes a file, the paused browser
// path run headless against local fixtures. Zero delays, a fast poll.
const log = pino({ level: "silent" });
const SETTLE_TIMEOUT = { timeout: 60_000, interval: 100 };

let bed: WorkerTestBed;
let worker: RunningWorker | undefined;

beforeAll(async () => {
  bed = await createWorkerTestBed();
  // Made-up value in the shape SoundCloud uses; never a real token.
  await saveSoundcloudAccount(bed.db, {
    oauthToken: "2-290123-123456789-aBcDeFgHiJkLmN",
    soundcloudUserId: "290123",
    username: "burner-digger",
  });
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

afterAll(async () => {
  await bed.close();
});

function envFor(overrides: Record<string, string> = {}): WorkerEnv {
  const env = parseEnv(workerEnvSchema, {
    DATABASE_URL: bed.database.url,
    DATA_DIR: bed.dataDir,
    ...overrides,
  });
  if (!env.ok) throw new Error(env.reason);
  return env.env;
}

/** Writes an MP3 where yt-dlp would, and prints its path like yt-dlp does. */
const fakeYtDlp: ProcessRunner = {
  run: async (_command, args) => {
    const template = args[args.indexOf("--output") + 1];
    if (template === undefined) throw new Error("fake yt-dlp: no --output");
    const file = template.replace("%(ext)s", "mp3");
    await writeFile(file, fakeMp3());
    return { ok: true, stdout: `${file}\n`, stderr: "" };
  },
};

async function start(options: Partial<StartWorkerOptions> = {}): Promise<RunningWorker> {
  const started = await startWorker({
    env: envFor(),
    log,
    delay: bed.delay,
    runner: fakeYtDlp,
    pollIntervalMs: 50,
    ...options,
  });
  if (!started.ok) throw new Error(started.reason);
  worker = started.worker;
  return started.worker;
}

async function statusesOf(jobIds: readonly string[]) {
  const rows = await bed.db
    .select({ id: schema.jobs.id, status: schema.jobs.status })
    .from(schema.jobs)
    .where(inArray(schema.jobs.id, [...jobIds]));
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

async function queueRun(pages: Parameters<WorkerTestBed["seedPlaylist"]>[0]) {
  const { playlistId } = await bed.seedPlaylist(pages);
  const run = await startPlaylistRun(bed.db, playlistId);
  if (!run.ok || run.runId === null) throw new Error("expected a run");
  return { runId: run.runId, jobIds: run.newJobIds };
}

describe("worker", () => {
  it("beats while it runs and clears its heartbeat when it stops", async () => {
    const running = await start();

    const beat = await readWorkerHeartbeat(bed.db);
    expect(beat?.pid).toBe(process.pid);

    await running.close();
    worker = undefined;
    expect(await readWorkerHeartbeat(bed.db)).toBeNull();
  });

  it("downloads queued tracks, including ones queued while it runs", async () => {
    await start();

    const first = await queueRun([{ name: "track" }, { name: "track", classification: "buy" }]);
    await vi.waitFor(
      async () =>
        expect(Object.values(await statusesOf(first.jobIds))).toEqual(["SUCCEEDED", "SUCCEEDED"]),
      SETTLE_TIMEOUT,
    );

    const second = await queueRun([{ name: "track" }]);
    await vi.waitFor(
      async () => expect(Object.values(await statusesOf(second.jobIds))).toEqual(["SUCCEEDED"]),
      SETTLE_TIMEOUT,
    );
  });

  it("runs a job a dead worker left running before anything else", async () => {
    const { jobIds } = await queueRun([{ name: "track" }, { name: "track" }]);
    const [interrupted, queued] = jobIds;
    if (interrupted === undefined || queued === undefined) throw new Error("expected two jobs");
    await bed.db
      .update(schema.jobs)
      .set({ status: "RUNNING" })
      .where(eq(schema.jobs.id, interrupted));

    await start();

    await vi.waitFor(
      async () =>
        expect(await statusesOf(jobIds)).toEqual({
          [interrupted]: "SUCCEEDED",
          [queued]: "SUCCEEDED",
        }),
      SETTLE_TIMEOUT,
    );
    const recovered = await bed.db
      .select({ type: schema.events.type })
      .from(schema.events)
      .where(eq(schema.events.jobId, interrupted));
    expect(recovered.map((event) => event.type)).toContain("recovered_after_restart");
  });

  it("runs browser jobs one at a time, in order; a parked track does not hold up the rest", async () => {
    await start({
      env: envFor({ NATIVE_DOWNLOAD_MODE: "browser" }),
      launchBrowser: bed.launchBrowser,
      registry: bed.registry,
      landmarkTimeoutMs: 750,
      downloadTimeoutMs: 1_500,
    });
    const before = bed.delay.calls.length;

    const { runId, jobIds } = await queueRun([
      { name: "captcha" },
      { name: "track" },
      { name: "removed" },
    ]);
    const [captcha, track, removed] = jobIds;
    if (captcha === undefined || track === undefined || removed === undefined) {
      throw new Error("expected three jobs");
    }

    await vi.waitFor(
      async () =>
        expect(await statusesOf(jobIds)).toEqual({
          [captcha]: "WAITING_FOR_HUMAN",
          [track]: "SUCCEEDED",
          [removed]: "MANUAL",
        }),
      SETTLE_TIMEOUT,
    );

    // Sequential: each job's events form one unbroken block, in queue order.
    const events = await bed.db
      .select({ jobId: schema.events.jobId })
      .from(schema.events)
      .where(eq(schema.events.runId, runId))
      .orderBy(asc(schema.events.id));
    const order = events
      .map((event) => event.jobId)
      .filter((id, index, all) => id !== all[index - 1]);
    expect(order).toEqual(jobIds);

    // A pause between tracks, after every one of them.
    await vi.waitFor(() =>
      expect(bed.delay.calls.slice(before).filter((kind) => kind === "between-jobs")).toHaveLength(
        3,
      ),
    );

    // The parked tab is still open; the run is finished, waiting on the human.
    const tabs =
      bed
        .context()
        ?.pages()
        .map((page) => page.url()) ?? [];
    expect(tabs).toContain(bed.server.pageUrl("captcha"));
    const [stored] = await bed.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(stored).toMatchObject({ status: "FINISHED", succeededCount: 1, manualCount: 1 });
    expect(bed.violations()).toEqual([]);
  });

  it("reports Postgres as unreachable instead of throwing", async () => {
    const result = await startWorker({
      env: { ...envFor(), DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" },
      log,
    });

    expect(result).toMatchObject({ ok: false, kind: "postgres_unreachable" });
  });
});
