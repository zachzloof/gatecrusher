import { QUEUE_NAME, TRACK_JOB_NAME, type TrackJobPayload } from "@gatecrusher/core";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { getEnv } from "./env";
import { getLogger } from "./logger";
import { waitUntilReady } from "./redis";
import type { TrackQueue } from "./run-handlers";
import { withTimeout } from "./with-timeout";

declare global {
  var __gatecrusherQueue: { queue: Queue; connection: Redis } | undefined;
}

const READY_TIMEOUT_MS = 2_000;
const ENQUEUE_TIMEOUT_MS = 5_000;
/** Finished queue jobs kept in Redis for inspection. The record of a job is in Postgres. */
const KEEP_FINISHED = 1_000;

function createQueue(): { queue: Queue; connection: Redis } {
  // BullMQ gets a connection of its own: it must not share the health check's, which
  // fails commands immediately while disconnected.
  const connection = new Redis(getEnv().REDIS_URL, {
    connectTimeout: READY_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  });
  connection.on("error", (error) => getLogger().debug({ err: error }, "Queue connection error"));
  const queue = new Queue(QUEUE_NAME, { connection });
  queue.on("error", (error) => getLogger().debug({ err: error }, "Queue error"));
  return { queue, connection };
}

/** One queue per process. Kept on globalThis so dev hot reloads do not leak connections. */
function getQueue(): { queue: Queue; connection: Redis } {
  globalThis.__gatecrusherQueue ??= createQueue();
  return globalThis.__gatecrusherQueue;
}

/** The real hand-over to the worker: one BullMQ job per track job, in order. */
export const trackQueue: TrackQueue = {
  isReady: async () => {
    try {
      await waitUntilReady(getQueue().connection, READY_TIMEOUT_MS);
      return true;
    } catch {
      // Not connected within the timeout: Redis is down or unreachable.
      return false;
    }
  },
  enqueue: async (jobIds) => {
    await withTimeout(
      getQueue().queue.addBulk(
        jobIds.map((jobId) => ({
          name: TRACK_JOB_NAME,
          data: { jobId } satisfies TrackJobPayload,
          opts: { removeOnComplete: KEEP_FINISHED, removeOnFail: KEEP_FINISHED },
        })),
      ),
      ENQUEUE_TIMEOUT_MS,
    );
  },
};
