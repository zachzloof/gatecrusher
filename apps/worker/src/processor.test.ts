import {
  pingJobResultSchema,
  trackJobResultSchema,
  type DelayKind,
  type TrackJobResult,
} from "@gatecrusher/core";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { processJob } from "./processor.ts";

const JOB_ID = "0b0e8c0e-6f5d-4c1e-9a43-2f6f1f0c7a11";

function fakeDeps(outcome: TrackJobResult["outcome"] = "succeeded", backOffMs?: number) {
  const processed: string[] = [];
  const delays: DelayKind[] = [];
  const backedOff: number[] = [];
  return {
    processed,
    delays,
    backedOff,
    deps: {
      log: pino({ level: "silent" }),
      now: () => new Date("2026-10-01T12:00:05.000Z"),
      processTrack: (jobId: string) => {
        processed.push(jobId);
        return Promise.resolve({
          result: { jobId, outcome },
          ...(backOffMs === undefined ? {} : { backOffMs }),
        });
      },
      backOff: (ms: number) => {
        backedOff.push(ms);
      },
      delay: {
        wait: (kind: DelayKind) => {
          delays.push(kind);
          return Promise.resolve();
        },
      },
    },
  };
}

const { deps } = fakeDeps();

describe("processJob", () => {
  it("answers a ping job", async () => {
    const result = await processJob(
      { id: "1", name: "ping", data: { requestedAt: "2026-10-01T12:00:00.000Z" } },
      deps,
    );

    expect(pingJobResultSchema.parse(result)).toEqual({
      pong: true,
      requestedAt: "2026-10-01T12:00:00.000Z",
      processedAt: "2026-10-01T12:00:05.000Z",
    });
  });

  it.each([{}, { requestedAt: "soon" }, null, "ping"])(
    "rejects a ping job with payload %j",
    async (data) => {
      await expect(processJob({ name: "ping", data }, deps)).rejects.toThrow(
        "Invalid ping job payload",
      );
    },
  );

  it("rejects job names it has no processor for", async () => {
    await expect(processJob({ name: "download", data: {} }, deps)).rejects.toThrow(
      'No processor registered for job "download"',
    );
  });

  it.each(["succeeded", "parked", "manual", "failed"] as const)(
    "runs a track job and then pauses before the next one (%s)",
    async (outcome) => {
      const fake = fakeDeps(outcome);

      const result = await processJob({ name: "track", data: { jobId: JOB_ID } }, fake.deps);

      expect(trackJobResultSchema.parse(result)).toEqual({ jobId: JOB_ID, outcome });
      expect(fake.processed).toEqual([JOB_ID]);
      expect(fake.delays).toEqual(["between-jobs"]);
    },
  );

  it("backs off when the site pushed back, and still pauses between jobs", async () => {
    const fake = fakeDeps("failed", 600_000);

    await processJob({ name: "track", data: { jobId: JOB_ID } }, fake.deps);

    expect(fake.backedOff).toEqual([600_000]);
    expect(fake.delays).toEqual(["between-jobs"]);
  });

  it("does not pause after a track job that had nothing to do", async () => {
    const fake = fakeDeps("skipped");

    await processJob({ name: "track", data: { jobId: JOB_ID } }, fake.deps);

    expect(fake.delays).toEqual([]);
  });

  it.each([{}, { jobId: "job-1" }, null])(
    "rejects a track job with payload %j without touching the browser",
    async (data) => {
      const fake = fakeDeps();

      await expect(processJob({ name: "track", data }, fake.deps)).rejects.toThrow(
        "Invalid track job payload",
      );
      expect(fake.processed).toEqual([]);
    },
  );
});
