import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
  type WorkerHeartbeat,
} from "@gatecrusher/core";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export interface HeartbeatOptions {
  redis: Redis;
  key: string;
  log: Logger;
}

export interface Heartbeat {
  /** Stops beating and removes the key so the worker reads as offline immediately. */
  stop(): Promise<void>;
}

/**
 * Refreshes a short-lived Redis key while the worker is alive. Web reads it to decide
 * whether to show the "worker offline" banner. A failed beat is logged, never thrown:
 * the key's TTL already makes a silent worker read as offline.
 */
export async function startHeartbeat({ redis, key, log }: HeartbeatOptions): Promise<Heartbeat> {
  const startedAt = new Date().toISOString();

  const beat = async (): Promise<void> => {
    const heartbeat: WorkerHeartbeat = {
      pid: process.pid,
      startedAt,
      beatAt: new Date().toISOString(),
    };
    try {
      await redis.set(key, JSON.stringify(heartbeat), "EX", WORKER_HEARTBEAT_TTL_SECONDS);
    } catch (error) {
      log.warn({ err: error }, "Worker heartbeat could not be written");
    }
  };

  await beat();
  const timer = setInterval(() => void beat(), WORKER_HEARTBEAT_INTERVAL_MS);

  return {
    stop: async () => {
      clearInterval(timer);
      try {
        await redis.del(key);
      } catch (error) {
        log.warn({ err: error }, "Worker heartbeat could not be cleared");
      }
    },
  };
}
