import { describe, expect, it } from "vitest";
import type { HealthResponse } from "./api-schemas";
import { describeProblem } from "./system-status";

function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "ok",
    db: { ok: true },
    redis: { ok: true },
    worker: { online: true, lastBeatAt: "2026-10-01T12:00:00.000Z" },
    checkedAt: "2026-10-01T12:00:01.000Z",
    ...overrides,
  };
}

describe("describeProblem", () => {
  it("shows nothing when everything is up", () => {
    expect(describeProblem(health())).toBeNull();
  });

  it("shows the worker-offline banner with the start command when there is no heartbeat", () => {
    expect(describeProblem(health({ worker: { online: false, lastBeatAt: null } }))).toEqual({
      message: "Worker offline. Nothing will download until it is started:",
      command: "pnpm --filter @gatecrusher/worker dev",
    });
  });

  it.each([
    [{ db: { ok: false } }, "Postgres unreachable"],
    [{ redis: { ok: false } }, "Redis unreachable"],
    [{ db: { ok: false }, redis: { ok: false } }, "Postgres and Redis unreachable"],
  ])("names the unreachable services before the worker", (overrides, expected) => {
    const problem = describeProblem(
      health({ ...overrides, status: "degraded", worker: { online: false, lastBeatAt: null } }),
    );

    expect(problem?.message).toContain(expected);
    expect(problem?.command).toBe("docker compose up -d");
  });

  it("says so when the server did not answer at all", () => {
    expect(describeProblem(null)).toEqual({
      message: "Can't reach the Gatecrusher server. Retrying…",
    });
  });
});
