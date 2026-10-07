import { z } from "zod";

// The queue is the `jobs` table: the worker takes the oldest QUEUED job, one at a time.

/** How often an idle worker looks for the next queued job. */
export const WORKER_POLL_INTERVAL_MS = 1_000;

export const TRACK_JOB_OUTCOMES = [
  "succeeded",
  /** Waiting for the human; its tab stays open and the queue moves on. */
  "parked",
  "manual",
  "failed",
  /** The job was not runnable any more (already finished, or still parked). */
  "skipped",
] as const;

export const trackJobResultSchema = z.object({
  jobId: z.uuid(),
  outcome: z.enum(TRACK_JOB_OUTCOMES),
});
export type TrackJobResult = z.infer<typeof trackJobResultSchema>;

/** The worker rewrites its heartbeat row this often while it is alive. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
/** A heartbeat older than this reads as offline. */
export const WORKER_HEARTBEAT_STALE_MS = 15_000;

export const workerHeartbeatSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  beatAt: z.iso.datetime(),
});
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
