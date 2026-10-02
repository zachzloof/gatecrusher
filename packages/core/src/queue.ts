import { z } from "zod";

/** The single BullMQ queue. Browser jobs are processed with concurrency 1. */
export const QUEUE_NAME = "gatecrusher";

/** No-op job used to prove the queue round-trip between web/CLI and the worker. */
export const PING_JOB_NAME = "ping";

export const pingJobPayloadSchema = z.object({
  requestedAt: z.iso.datetime(),
});
export type PingJobPayload = z.infer<typeof pingJobPayloadSchema>;

export const pingJobResultSchema = z.object({
  pong: z.literal(true),
  requestedAt: z.iso.datetime(),
  processedAt: z.iso.datetime(),
});
export type PingJobResult = z.infer<typeof pingJobResultSchema>;

/** One browser job: run (or resume) the adapter for one row of the `jobs` table. */
export const TRACK_JOB_NAME = "track";

export const trackJobPayloadSchema = z.object({
  jobId: z.uuid(),
});
export type TrackJobPayload = z.infer<typeof trackJobPayloadSchema>;

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

/** Redis key the worker refreshes while it is alive; web reads it for /api/health. */
export const WORKER_HEARTBEAT_KEY = "gatecrusher:worker:heartbeat";
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
/** The key expires after this long without a beat, so a dead worker reads as offline. */
export const WORKER_HEARTBEAT_TTL_SECONDS = 15;

export const workerHeartbeatSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  beatAt: z.iso.datetime(),
});
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
