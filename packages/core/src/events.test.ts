import { describe, expect, it } from "vitest";
import { HUMAN_REASONS } from "./domain.ts";
import { jobEventSchema, needsHumanEventSchema } from "./events.ts";
import { JOB_STATUSES } from "./job-status.ts";

const valid = {
  type: "needs_human",
  jobId: "0b0e8c0e-6f5d-4c1e-9a43-2f6f1f0c7a11",
  trackId: "5f0c3a52-3a55-4d0b-8f0e-0d8b7f6e2c22",
  runId: "9a1d2c3b-4e5f-4a6b-8c7d-1e2f3a4b5c33",
  humanRequestId: "c4d5e6f7-0a1b-4c2d-9e3f-4a5b6c7d8e44",
  adapterId: "hypeddit",
  stepIndex: 3,
  stepName: "follow-artist",
  reason: "captcha",
  description: "Solve the captcha in the browser window, then click Continue.",
  screenshotPath: "screenshots/run/job/004-captcha.png",
  pageUrl: "https://gate.example/track/123",
  sessionAlive: true,
  createdAt: "2026-10-01T12:00:00.000Z",
};

describe("needsHumanEventSchema", () => {
  it("accepts a complete event", () => {
    expect(needsHumanEventSchema.parse(valid)).toEqual(valid);
  });

  it.each(HUMAN_REASONS)("accepts reason %s", (reason) => {
    expect(needsHumanEventSchema.safeParse({ ...valid, reason }).success).toBe(true);
  });

  it.each([
    ["a wrong type", { type: "status" }],
    ["a non-uuid job id", { jobId: "job-1" }],
    ["a negative step index", { stepIndex: -1 }],
    ["a manual reason", { reason: "dead_link" }],
    ["an empty description", { description: "" }],
    ["an over-long description", { description: "x".repeat(281) }],
    ["an empty screenshot path", { screenshotPath: "" }],
    ["a non-http page url", { pageUrl: "file:///etc/passwd" }],
    ["a non-ISO timestamp", { createdAt: "yesterday" }],
    ["a missing sessionAlive", { sessionAlive: undefined }],
  ])("rejects %s", (_label, override) => {
    expect(needsHumanEventSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});

describe("jobEventSchema", () => {
  const ids = { jobId: valid.jobId, runId: valid.runId };
  const step = { stepIndex: 1, stepName: "open-more" };
  const download = {
    path: "downloads/fixture-crate/Fixture Artist - Fixture Track.mp3",
    sizeBytes: 2_000_000,
    mimeType: "audio/mpeg",
    kind: "audio",
    checksumSha256: "a".repeat(64),
  };

  const events = [
    {
      type: "job_started",
      ...ids,
      status: "RUNNING",
      adapterId: "native-soundcloud",
      attempt: 1,
      resumedOnOpenPage: false,
    },
    { type: "recovered_after_restart", ...ids, status: "QUEUED" },
    { type: "step_started", ...ids, ...step, status: "RUNNING" },
    {
      type: "step_finished",
      ...ids,
      ...step,
      status: "RUNNING",
      outcome: "next",
      screenshotPath: "screenshots/run/job/0002-open-more.png",
    },
    { type: "adapter_note", ...ids, status: "RUNNING", message: "Menu was already open" },
    valid,
    { type: "job_succeeded", ...ids, status: "SUCCEEDED", download },
    {
      type: "job_manual",
      ...ids,
      status: "MANUAL",
      reason: "dead_link",
      detail: "Removed",
      link: "https://soundcloud.com/fixture-artist/fixture-track",
    },
    { type: "job_failed", ...ids, status: "FAILED", error: "Browser closed" },
    { type: "job_continued", ...ids, status: "QUEUED" },
    { type: "job_cancelled", ...ids, status: "CANCELLED" },
  ];

  it.each(events)("accepts $type", (event) => {
    expect(jobEventSchema.parse(event)).toEqual(event);
  });

  it("carries a real job status on every event that has one", () => {
    for (const event of events) {
      if ("status" in event) expect(JOB_STATUSES).toContain(event.status);
    }
  });

  it("allows a step to finish without a screenshot, but not with an empty path", () => {
    const finished = events[3];

    expect(jobEventSchema.safeParse({ ...finished, screenshotPath: null }).success).toBe(true);
    expect(jobEventSchema.safeParse({ ...finished, screenshotPath: "" }).success).toBe(false);
  });

  it.each([
    ["an unknown type", { type: "job_exploded", ...ids }],
    ["a status that does not match the event", { ...events[0], status: "SUCCEEDED" }],
    ["a step outcome that is not one of the four", { ...events[3], outcome: "failed" }],
    ["a step event without a step name", { ...events[2], stepName: "" }],
    ["a manual event for a human blocker", { ...events[7], reason: "captcha" }],
    ["a manual event without a link", { ...events[7], link: undefined }],
    ["a manual event with a non-http link", { ...events[7], link: "javascript:alert(1)" }],
    ["a success without a download", { ...events[6], download: undefined }],
    ["a failure without an error", { ...events[8], error: "" }],
    ["a non-uuid job id", { ...events[1], jobId: "job-1" }],
    ["a zero attempt", { ...events[0], attempt: 0 }],
  ])("rejects %s", (_label, event) => {
    expect(jobEventSchema.safeParse(event).success).toBe(false);
  });
});
