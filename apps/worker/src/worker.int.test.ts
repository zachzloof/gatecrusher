import { randomBytes } from "node:crypto";
import {
  PING_JOB_NAME,
  parseEnv,
  pingJobResultSchema,
  workerEnvSchema,
  workerHeartbeatSchema,
} from "@gatecrusher/core";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type RunningWorker } from "./worker.ts";

const envResult = parseEnv(workerEnvSchema, {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://gatecrusher:gatecrusher@localhost:5432/gatecrusher",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
});
if (!envResult.ok) throw new Error(envResult.reason);
const env = envResult.env;
const log = pino({ level: "silent" });

// A throwaway namespace, so the test can run next to a real worker on the same Redis.
const suffix = randomBytes(6).toString("hex");
const queueName = `gatecrusher-test-${suffix}`;
const queuePrefix = `gatecrusher-test-${suffix}`;
const heartbeatKey = `gatecrusher-test:${suffix}:heartbeat`;

let redis: Redis;
let eventsRedis: Redis;
let queue: Queue;
let queueEvents: QueueEvents;
let worker: RunningWorker | undefined;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(queueName, { connection: redis, prefix: queuePrefix });
  eventsRedis = redis.duplicate();
  queueEvents = new QueueEvents(queueName, { connection: eventsRedis, prefix: queuePrefix });
  await queueEvents.waitUntilReady();
});

afterAll(async () => {
  await worker?.close();
  await queueEvents.close();
  await queue.obliterate({ force: true });
  await queue.close();
  // BullMQ does not close connections it was handed.
  eventsRedis.disconnect();
  await redis.quit();
});

describe("worker", () => {
  it("connects to Postgres and Redis and publishes a heartbeat", async () => {
    const started = await startWorker({ env, log, queueName, queuePrefix, heartbeatKey });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    worker = started.worker;

    const raw = await redis.get(heartbeatKey);
    expect(raw).not.toBeNull();
    const heartbeat = workerHeartbeatSchema.parse(JSON.parse(raw ?? "null"));
    expect(heartbeat.pid).toBe(process.pid);
    expect(await redis.ttl(heartbeatKey)).toBeGreaterThan(0);
  });

  it("processes a ping job from the queue", async () => {
    const job = await queue.add(PING_JOB_NAME, { requestedAt: new Date().toISOString() });

    const result = pingJobResultSchema.parse(await job.waitUntilFinished(queueEvents, 15_000));

    expect(result.pong).toBe(true);
  });

  it("fails a job it has no processor for, and keeps running", async () => {
    const unknown = await queue.add("not-a-real-job", {});
    await expect(unknown.waitUntilFinished(queueEvents, 15_000)).rejects.toThrow(
      /No processor registered/,
    );

    const ping = await queue.add(PING_JOB_NAME, { requestedAt: new Date().toISOString() });
    await expect(ping.waitUntilFinished(queueEvents, 15_000)).resolves.toMatchObject({
      pong: true,
    });
  });

  it("clears its heartbeat on shutdown", async () => {
    await worker?.close();
    worker = undefined;

    expect(await redis.get(heartbeatKey)).toBeNull();
  });
});

describe("startWorker with unreachable services", () => {
  it("reports Postgres as unreachable instead of throwing", async () => {
    const result = await startWorker({
      env: { ...env, DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" },
      log,
      queueName,
      queuePrefix,
      heartbeatKey,
    });

    expect(result).toMatchObject({ ok: false, kind: "postgres_unreachable" });
  });

  it("reports Redis as unreachable instead of throwing", async () => {
    const result = await startWorker({
      env: { ...env, REDIS_URL: "redis://127.0.0.1:1" },
      log,
      queueName,
      queuePrefix,
      heartbeatKey,
    });

    expect(result).toMatchObject({ ok: false, kind: "redis_unreachable" });
  });
});
