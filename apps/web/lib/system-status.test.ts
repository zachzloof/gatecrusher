import { describe, expect, it } from "vitest";
import type { HealthResponse } from "./api-schemas";
import { describeProblem } from "./system-status";

function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "ok",
    db: { ok: true },
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

  it("names Postgres before the worker", () => {
    const problem = describeProblem(
      health({
        db: { ok: false },
        status: "degraded",
        worker: { online: false, lastBeatAt: null },
      }),
    );

    expect(problem).toEqual({
      message: "Postgres unreachable. Start it:",
      command: "docker compose up -d",
    });
  });

  it("tells a desktop user to restart the app instead of giving a command", () => {
    const offline = health({ worker: { online: false, lastBeatAt: null } });
    const dbDown = health({ db: { ok: false }, status: "degraded" });

    expect(describeProblem(offline, { desktop: true })?.command).toBeUndefined();
    expect(describeProblem(offline, { desktop: true })?.message).toContain("quit Gatecrusher");
    expect(describeProblem(dbDown, { desktop: true })).toEqual({
      message: "The database stopped. Quit Gatecrusher and open it again.",
    });
  });

  it("says so when the server did not answer at all", () => {
    expect(describeProblem(null)).toEqual({
      message: "Can't reach the Gatecrusher server. Retrying…",
    });
  });
});
