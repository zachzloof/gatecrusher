import { describe, expect, it } from "vitest";
import { TRACK_JOB_OUTCOMES, trackJobPayloadSchema, trackJobResultSchema } from "./queue.ts";

const jobId = "0b0e8c0e-6f5d-4c1e-9a43-2f6f1f0c7a11";

describe("trackJobPayloadSchema", () => {
  it("accepts a job id", () => {
    expect(trackJobPayloadSchema.parse({ jobId })).toEqual({ jobId });
  });

  it.each([{}, { jobId: "job-1" }, { jobId: 7 }, null, "track"])("rejects %j", (payload) => {
    expect(trackJobPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("trackJobResultSchema", () => {
  it.each(TRACK_JOB_OUTCOMES)("accepts outcome %s", (outcome) => {
    expect(trackJobResultSchema.safeParse({ jobId, outcome }).success).toBe(true);
  });

  it("has no outcome for a captcha: that is a parked job", () => {
    expect(trackJobResultSchema.safeParse({ jobId, outcome: "captcha" }).success).toBe(false);
    expect(TRACK_JOB_OUTCOMES).toContain("parked");
  });
});
