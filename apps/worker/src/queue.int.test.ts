import { randomBytes } from "node:crypto";
import {
  parseEnv,
  TRACK_JOB_NAME,
  trackJobResultSchema,
  workerEnvSchema,
  type TrackJobPayload,
} from "@gatecrusher/core";
import { schema, startNativeRun } from "@gatecrusher/db";
import { Queue, QueueEvents } from "bullmq";
import { asc, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerTestBed, type WorkerTestBed } from "./testing.ts";
import { startWorker, type RunningWorker } from "./worker.ts";

// The whole worker: real BullMQ on Redis, real Postgres, the real processor — with a
// headless browser on local fixtures, zero delays and a throwaway queue namespace.
const suffix = randomBytes(6).toString("hex");
const queueName = `gatecrusher-test-${suffix}`;
const queuePrefix = `gatecrusher-test-${suffix}`;
const heartbeatKey = `gatecrusher-test:${suffix}:heartbeat`;

let bed: WorkerTestBed;
let redis: Redis;
let eventsRedis: Redis;
let queue: Queue;
let queueEvents: QueueEvents;
let worker: RunningWorker;

beforeAll(async () => {
  bed = await createWorkerTestBed();
  const env = parseEnv(workerEnvSchema, {
    DATABASE_URL: bed.database.url,
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    DATA_DIR: bed.dataDir,
  });
  if (!env.ok) throw new Error(env.reason);

  redis = new Redis(env.env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(queueName, { connection: redis, prefix: queuePrefix });
  eventsRedis = redis.duplicate();
  queueEvents = new QueueEvents(queueName, { connection: eventsRedis, prefix: queuePrefix });
  await queueEvents.waitUntilReady();

  const started = await startWorker({
    env: env.env,
    log: pino({ level: "silent" }),
    queueName,
    queuePrefix,
    heartbeatKey,
    launchBrowser: bed.launchBrowser,
    delay: bed.delay,
    registry: bed.registry,
    landmarkTimeoutMs: 750,
    downloadTimeoutMs: 1_500,
  });
  if (!started.ok) throw new Error(started.reason);
  worker = started.worker;
});

afterAll(async () => {
  await worker.close();
  await queueEvents.close();
  await queue.obliterate({ force: true });
  await queue.close();
  // BullMQ does not close connections it was handed.
  eventsRedis.disconnect();
  await redis.quit();
  await bed.close();
});

describe("worker: track jobs from the queue", () => {
  it("does not open a browser until a browser job arrives", () => {
    expect(bed.context()).toBeUndefined();
  });

  it("runs tracks one at a time, in order, and a parked track does not hold up the rest", async () => {
    const { playlistId } = await bed.seedPlaylist([
      { name: "captcha" },
      { name: "track" },
      { name: "removed" },
    ]);
    const run = await startNativeRun(bed.db, playlistId);
    if (!run.ok || run.runId === null) throw new Error("expected a run");

    const queued = await queue.addBulk(
      run.newJobIds.map((jobId) => ({
        name: TRACK_JOB_NAME,
        data: { jobId } satisfies TrackJobPayload,
      })),
    );
    const results = await Promise.all(
      queued.map(async (job) =>
        trackJobResultSchema.parse(await job.waitUntilFinished(queueEvents, 60_000)),
      ),
    );

    expect(results.map((result) => result.outcome)).toEqual(["parked", "succeeded", "manual"]);
    const jobs = await bed.db.select().from(schema.jobs).where(eq(schema.jobs.runId, run.runId));
    expect(Object.fromEntries(jobs.map((job) => [job.id, job.status]))).toEqual({
      [run.newJobIds[0] ?? ""]: "WAITING_FOR_HUMAN",
      [run.newJobIds[1] ?? ""]: "SUCCEEDED",
      [run.newJobIds[2] ?? ""]: "MANUAL",
    });

    // Sequential: each job's events form one unbroken block, in queue order.
    const events = await bed.db
      .select({ jobId: schema.events.jobId })
      .from(schema.events)
      .where(eq(schema.events.runId, run.runId))
      .orderBy(asc(schema.events.id));
    const order = events
      .map((event) => event.jobId)
      .filter((id, index, all) => id !== all[index - 1]);
    expect(order).toEqual(run.newJobIds);

    // A pause between tracks, after every one of them.
    expect(bed.delay.calls.filter((kind) => kind === "between-jobs")).toHaveLength(3);

    // The parked tab is still open; the run is finished, waiting on the human.
    const tabs =
      bed
        .context()
        ?.pages()
        .map((page) => page.url()) ?? [];
    expect(tabs).toContain(bed.server.pageUrl("captcha"));
    const [stored] = await bed.db.select().from(schema.runs).where(eq(schema.runs.id, run.runId));
    expect(stored).toMatchObject({ status: "FINISHED", succeededCount: 1, manualCount: 1 });
    expect(bed.violations()).toEqual([]);
  });

  it("fails a queue job with a malformed payload without touching the database", async () => {
    const job = await queue.add(TRACK_JOB_NAME, { jobId: "not-a-uuid" });

    await expect(job.waitUntilFinished(queueEvents, 15_000)).rejects.toThrow(
      /Invalid track job payload/,
    );
  });
});
