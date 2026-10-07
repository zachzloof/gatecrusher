import { WORKER_HEARTBEAT_STALE_MS, workerHeartbeatSchema } from "@gatecrusher/core";
import type { HealthResponse } from "./api-schemas";
import { withTimeout } from "./with-timeout";

const PROBE_TIMEOUT_MS = 2_000;

export type HealthService = "db" | "worker";

export interface HealthProbes {
  /** Rejects when Postgres cannot answer a trivial query. */
  pingDb(): Promise<unknown>;
  /** The heartbeat row the worker keeps in Postgres, or null when there is none. */
  readHeartbeat(): Promise<unknown>;
  onError?(service: HealthService, error: unknown): void;
  now?(): Date;
}

/** The last heartbeat time, if it is well-formed and recent enough to count as alive. */
function freshBeat(raw: unknown, now: Date): string | null {
  if (raw === null) return null;
  const heartbeat = workerHeartbeatSchema.safeParse(raw);
  if (!heartbeat.success) return null;

  const ageMs = now.getTime() - new Date(heartbeat.data.beatAt).getTime();
  return ageMs <= WORKER_HEARTBEAT_STALE_MS ? heartbeat.data.beatAt : null;
}

/** Never rejects: an unreachable service is a result, not an error. */
export async function checkHealth(probes: HealthProbes): Promise<HealthResponse> {
  const now = probes.now?.() ?? new Date();

  let dbOk = false;
  try {
    await withTimeout(probes.pingDb(), PROBE_TIMEOUT_MS);
    dbOk = true;
  } catch (error) {
    probes.onError?.("db", error);
  }

  let lastBeatAt: string | null = null;
  if (dbOk) {
    try {
      lastBeatAt = freshBeat(await withTimeout(probes.readHeartbeat(), PROBE_TIMEOUT_MS), now);
    } catch (error) {
      probes.onError?.("worker", error);
    }
  }

  return {
    status: dbOk ? "ok" : "degraded",
    db: { ok: dbOk },
    worker: { online: lastBeatAt !== null, lastBeatAt },
    checkedAt: now.toISOString(),
  };
}
