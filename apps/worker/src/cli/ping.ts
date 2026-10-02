// Enqueues one no-op `ping` job and waits for a running worker to answer it:
//   pnpm --filter @gatecrusher/worker enqueue-ping
import {
  PING_JOB_NAME,
  QUEUE_NAME,
  pingJobResultSchema,
  type PingJobPayload,
} from "@gatecrusher/core";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "../env.ts";
import { createLogger } from "../logger.ts";

const ANSWER_TIMEOUT_MS = 10_000;

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);

// BullMQ does not close connections it was handed, so both are kept to close them here.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const eventsConnection = connection.duplicate();
for (const redis of [connection, eventsConnection]) {
  redis.on("error", (error) => log.warn({ err: error }, "Redis connection error"));
}
const queue = new Queue(QUEUE_NAME, { connection });
const queueEvents = new QueueEvents(QUEUE_NAME, { connection: eventsConnection });

try {
  await queueEvents.waitUntilReady();
  const payload: PingJobPayload = { requestedAt: new Date().toISOString() };
  const job = await queue.add(PING_JOB_NAME, payload, {
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  log.info({ queueJobId: job.id }, "Ping job enqueued, waiting for the worker");

  const result = pingJobResultSchema.parse(
    await job.waitUntilFinished(queueEvents, ANSWER_TIMEOUT_MS),
  );
  log.info(result, "Worker answered the ping");
} catch (error) {
  log.error(
    { err: error },
    "No answer from the worker. Is it running? Start it with: pnpm --filter @gatecrusher/worker dev",
  );
  process.exitCode = 1;
} finally {
  await queueEvents.close();
  await queue.close();
  eventsConnection.disconnect();
  connection.disconnect();
}
