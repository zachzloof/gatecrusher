import { WORKER_HEARTBEAT_TTL_SECONDS, workerHeartbeatSchema } from "@gatecrusher/core";
import type { HealthResponse } from "./api-schemas";
import { withTimeout } from "./with-timeout";

const PROBE_TIMEOUT_MS = 2_000;

export type HealthService = "db" | "redis" | "worker";

export interface HealthProbes {
  /** Rejects when Postgres cannot answer a trivial query. */
  pingDb(): Promise<unknown>;
  /** Rejects when Redis cannot answer PING. */
  pingRedis(): Promise<unknown>;
  /** The raw heartbeat value the worker keeps in Redis, or null when there is none. */
  readHeartbeat(): Promise<string | null>;
  onError?(service: HealthService, error: unknown): void;
  now?(): Date;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON: the schema below rejects it and the worker reads as offline.
    return undefined;
  }
}

/** The last heartbeat time, if it is well-formed and recent enough to count as alive. */
function freshBeat(raw: string | null, now: Date): string | null {
  if (raw === null) return null;
  const heartbeat = workerHeartbeatSchema.safeParse(parseJson(raw));
  if (!heartbeat.success) return null;

  const ageMs = now.getTime() - new Date(heartbeat.data.beatAt).getTime();
  return ageMs <= WORKER_HEARTBEAT_TTL_SECONDS * 1_000 ? heartbeat.data.beatAt : null;
}

/** Never rejects: an unreachable service is a result, not an error. */
export async function checkHealth(probes: HealthProbes): Promise<HealthResponse> {
  const now = probes.now?.() ?? new Date();

  const succeeds = async (service: HealthService, probe: () => Promise<unknown>) => {
    try {
      await withTimeout(probe(), PROBE_TIMEOUT_MS);
      return true;
    } catch (error) {
      probes.onError?.(service, error);
      return false;
    }
  };

  const [dbOk, redisOk] = await Promise.all([
    succeeds("db", () => probes.pingDb()),
    succeeds("redis", () => probes.pingRedis()),
  ]);

  let lastBeatAt: string | null = null;
  if (redisOk) {
    try {
      lastBeatAt = freshBeat(await withTimeout(probes.readHeartbeat(), PROBE_TIMEOUT_MS), now);
    } catch (error) {
      probes.onError?.("worker", error);
    }
  }

  return {
    status: dbOk && redisOk ? "ok" : "degraded",
    db: { ok: dbOk },
    redis: { ok: redisOk },
    worker: { online: lastBeatAt !== null, lastBeatAt },
    checkedAt: now.toISOString(),
  };
}
