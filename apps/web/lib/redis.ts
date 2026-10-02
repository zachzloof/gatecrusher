import { Redis } from "ioredis";
import { getEnv } from "./env";
import { getLogger } from "./logger";

declare global {
  var __gatecrusherRedis: Redis | undefined;
}

function createRedis(): Redis {
  const redis = new Redis(getEnv().REDIS_URL, {
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    // Fail commands straight away while disconnected instead of queueing them, so a
    // request never hangs on a Redis outage.
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  });
  // Reconnects are automatic and /api/health reports the outage; without a listener
  // ioredis would print every failed attempt as an unhandled error.
  redis.on("error", (error) => getLogger().debug({ err: error }, "Redis connection error"));
  return redis;
}

/** One connection per process. Kept on globalThis so dev hot reloads do not leak it. */
export function getRedis(): Redis {
  globalThis.__gatecrusherRedis ??= createRedis();
  return globalThis.__gatecrusherRedis;
}

/** Resolves once the connection is usable; rejects if that takes longer than `timeoutMs`. */
export function waitUntilReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === "ready") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      redis.off("ready", onReady);
      reject(new Error("Redis connection is not ready"));
    }, timeoutMs);
    redis.once("ready", onReady);
  });
}
