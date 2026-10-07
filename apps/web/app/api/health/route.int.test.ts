import { afterAll, describe, expect, it } from "vitest";
import { healthResponseSchema } from "@/lib/api-schemas";
import { getDb } from "@/lib/db";
import { GET } from "./route";

// Runs against the Compose Postgres. No assertion is made about the worker, which may
// or may not be running on this machine.
afterAll(async () => {
  await getDb().close();
});

describe("GET /api/health", () => {
  it("reports Postgres as reachable", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = healthResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ status: "ok", db: { ok: true } });
  });
});
