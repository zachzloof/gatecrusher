import { describe, expect, it, vi } from "vitest";
import { healthResponseSchema } from "./api-schemas";
import { checkHealth, type HealthProbes } from "./health";

const now = new Date("2026-10-01T12:00:00.000Z");
const beat = (secondsAgo: number): string =>
  JSON.stringify({
    pid: 4242,
    startedAt: "2026-10-01T11:00:00.000Z",
    beatAt: new Date(now.getTime() - secondsAgo * 1_000).toISOString(),
  });

function probes(overrides: Partial<HealthProbes> = {}): HealthProbes {
  return {
    pingDb: () => Promise.resolve(),
    pingRedis: () => Promise.resolve(),
    readHeartbeat: () => Promise.resolve(beat(2)),
    now: () => now,
    ...overrides,
  };
}

describe("checkHealth", () => {
  it("reports ok with the worker online when everything answers", async () => {
    const health = await checkHealth(probes());

    expect(healthResponseSchema.parse(health)).toEqual({
      status: "ok",
      db: { ok: true },
      redis: { ok: true },
      worker: { online: true, lastBeatAt: "2026-10-01T11:59:58.000Z" },
      checkedAt: "2026-10-01T12:00:00.000Z",
    });
  });

  it.each([
    ["no heartbeat", null],
    ["a stale heartbeat", beat(60)],
    ["a malformed heartbeat", "{not json"],
    ["a heartbeat of the wrong shape", JSON.stringify({ pid: "x" })],
  ])("reports the worker offline for %s, and is still ok", async (_label, raw) => {
    const health = await checkHealth(probes({ readHeartbeat: () => Promise.resolve(raw) }));

    expect(health.status).toBe("ok");
    expect(health.worker).toEqual({ online: false, lastBeatAt: null });
  });

  it("reports degraded when Postgres is down", async () => {
    const onError = vi.fn();
    const health = await checkHealth(
      probes({ pingDb: () => Promise.reject(new Error("ECONNREFUSED")), onError }),
    );

    expect(health.status).toBe("degraded");
    expect(health.db.ok).toBe(false);
    expect(health.redis.ok).toBe(true);
    expect(onError).toHaveBeenCalledWith("db", expect.any(Error));
  });

  it("reports degraded and the worker offline when Redis is down", async () => {
    const readHeartbeat = vi.fn(() => Promise.resolve(beat(1)));
    const health = await checkHealth(
      probes({ pingRedis: () => Promise.reject(new Error("ECONNREFUSED")), readHeartbeat }),
    );

    expect(health.status).toBe("degraded");
    expect(health.redis.ok).toBe(false);
    expect(health.worker.online).toBe(false);
    expect(readHeartbeat).not.toHaveBeenCalled();
  });

  it("treats a failed heartbeat read as worker offline", async () => {
    const onError = vi.fn();
    const health = await checkHealth(
      probes({ readHeartbeat: () => Promise.reject(new Error("boom")), onError }),
    );

    expect(health.worker.online).toBe(false);
    expect(onError).toHaveBeenCalledWith("worker", expect.any(Error));
  });

  it("gives up on a probe that never answers", async () => {
    vi.useFakeTimers();
    try {
      const pending = checkHealth(probes({ pingDb: () => new Promise(() => undefined) }));
      await vi.advanceTimersByTimeAsync(2_000);

      expect((await pending).db.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
