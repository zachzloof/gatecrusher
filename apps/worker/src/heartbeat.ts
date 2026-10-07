import { WORKER_HEARTBEAT_INTERVAL_MS } from "@gatecrusher/core";
import { clearWorkerHeartbeat, writeWorkerHeartbeat, type Database } from "@gatecrusher/db";
import type { Logger } from "pino";

export interface HeartbeatOptions {
  db: Database;
  log: Logger;
  intervalMs?: number;
}

export interface Heartbeat {
  /** Stops beating and removes the row so the worker reads as offline immediately. */
  stop(): Promise<void>;
}

/**
 * Rewrites the heartbeat row while the worker is alive. Web reads it to decide whether
 * to show the "worker offline" banner. A failed beat is logged, never thrown: a row
 * that stops changing already reads as offline once it is stale.
 */
export async function startHeartbeat({
  db,
  log,
  intervalMs,
}: HeartbeatOptions): Promise<Heartbeat> {
  const startedAt = new Date();

  const beat = async (): Promise<void> => {
    try {
      await writeWorkerHeartbeat(db, { pid: process.pid, startedAt, beatAt: new Date() });
    } catch (error) {
      log.warn({ err: error }, "Worker heartbeat could not be written");
    }
  };

  let inFlight = beat();
  await inFlight;
  const timer = setInterval(() => {
    inFlight = beat();
  }, intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);

  return {
    stop: async () => {
      clearInterval(timer);
      // A beat still being written would otherwise land after the row is removed.
      await inFlight;
      try {
        await clearWorkerHeartbeat(db, process.pid);
      } catch (error) {
        log.warn({ err: error }, "Worker heartbeat could not be cleared");
      }
    },
  };
}
