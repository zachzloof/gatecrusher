import { describe, expect, it } from "vitest";
import { TRACK_JOB_OUTCOMES, trackJobResultSchema, workerHeartbeatSchema } from "./queue.ts";

const jobId = "0b0e8c0e-6f5d-4c1e-9a43-2f6f1f0c7a11";

describe("trackJobResultSchema", () => {
  it.each(TRACK_JOB_OUTCOMES)("accepts outcome %s", (outcome) => {
    expect(trackJobResultSchema.safeParse({ jobId, outcome }).success).toBe(true);
  });

  it("has no outcome for a captcha: that is a parked job", () => {
    expect(trackJobResultSchema.safeParse({ jobId, outcome: "captcha" }).success).toBe(false);
    expect(TRACK_JOB_OUTCOMES).toContain("parked");
  });
});

describe("workerHeartbeatSchema", () => {
  it("accepts a heartbeat", () => {
    const beat = {
      pid: 42,
      startedAt: "2026-10-01T12:00:00.000Z",
      beatAt: "2026-10-01T12:00:05.000Z",
    };
    expect(workerHeartbeatSchema.parse(beat)).toEqual(beat);
  });

  it.each([{}, { pid: 0, startedAt: "x", beatAt: "y" }, null])("rejects %j", (beat) => {
    expect(workerHeartbeatSchema.safeParse(beat).success).toBe(false);
  });
});
