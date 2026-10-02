import { WORKER_HEARTBEAT_KEY } from "@gatecrusher/core";
import { NextResponse } from "next/server";
import { healthResponseSchema } from "@/lib/api-schemas";
import { getDb } from "@/lib/db";
import { checkHealth } from "@/lib/health";
import { getLogger } from "@/lib/logger";
import { getRedis, waitUntilReady } from "@/lib/redis";

export const dynamic = "force-dynamic";

const REDIS_READY_TIMEOUT_MS = 1_500;

/** 200 when Postgres and Redis answer, 503 otherwise. Worker status is in the body. */
export async function GET(): Promise<NextResponse> {
  const redis = getRedis();

  const health = await checkHealth({
    pingDb: () => getDb().ping(),
    pingRedis: async () => {
      await waitUntilReady(redis, REDIS_READY_TIMEOUT_MS);
      await redis.ping();
    },
    readHeartbeat: () => redis.get(WORKER_HEARTBEAT_KEY),
    onError: (service, error) =>
      getLogger().warn({ service, err: error }, "Health check: service unreachable"),
  });

  return NextResponse.json(healthResponseSchema.parse(health), {
    status: health.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
