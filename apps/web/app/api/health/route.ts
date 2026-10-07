import { readWorkerHeartbeat } from "@gatecrusher/db";
import { NextResponse } from "next/server";
import { healthResponseSchema } from "@/lib/api-schemas";
import { getDb } from "@/lib/db";
import { checkHealth } from "@/lib/health";
import { getLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** 200 when Postgres answers, 503 otherwise. Worker status is in the body. */
export async function GET(): Promise<NextResponse> {
  const health = await checkHealth({
    pingDb: () => getDb().ping(),
    readHeartbeat: () => readWorkerHeartbeat(getDb().db),
    onError: (service, error) =>
      getLogger().warn({ service, err: error }, "Health check: service unreachable"),
  });

  return NextResponse.json(healthResponseSchema.parse(health), {
    status: health.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
