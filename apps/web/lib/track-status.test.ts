import { describe, expect, it } from "vitest";
import type { TrackDto, TrackJobDto } from "./api-schemas";
import {
  nativeProgress,
  progressSummary,
  runResultMessage,
  statusDetail,
  statusExplanation,
  trackStatus,
} from "./track-status";

function job(overrides: Partial<TrackJobDto>): TrackJobDto {
  return {
    status: "QUEUED",
    stepName: null,
    needsHuman: null,
    manual: null,
    error: null,
    ...overrides,
  };
}

function track(overrides: Partial<TrackDto> = {}): TrackDto {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    position: 0,
    title: "Track",
    artist: "Artist",
    permalinkUrl: "https://soundcloud.com/a/track",
    artworkUrl: null,
    durationMs: 200_000,
    classification: "native",
    gatePlatform: null,
    purchaseUrl: null,
    purchaseTitle: null,
    job: null,
    download: null,
    ...overrides,
  };
}

const download = { fileName: "Artist - Track.mp3", sizeBytes: 2_000_000, kind: "audio" as const };
const needsHuman = {
  reason: "captcha" as const,
  description: "Solve the captcha in the worker's browser window.",
  screenshotUrl: "/api/screenshots/r/j/0002-open-more.png",
};

describe("trackStatus", () => {
  it("is null for a track that has never been run", () => {
    expect(trackStatus(track())).toBeNull();
  });

  it("is the job's status", () => {
    expect(trackStatus(track({ job: job({ status: "RUNNING" }) }))).toBe("RUNNING");
  });

  it("is Downloaded whenever there is a verified download, whatever a later job did", () => {
    expect(trackStatus(track({ download }))).toBe("SUCCEEDED");
    expect(trackStatus(track({ download, job: job({ status: "FAILED", error: "x" }) }))).toBe(
      "SUCCEEDED",
    );
  });
});

describe("statusDetail and statusExplanation", () => {
  it("names the step of a running job", () => {
    const running = track({ job: job({ status: "RUNNING", stepName: "open-more" }) });

    expect(statusDetail(running)).toBe("open-more");
    expect(statusExplanation(running)).toBeUndefined();
  });

  it("gives the instruction for a job that needs the human", () => {
    const waiting = track({
      job: job({ status: "WAITING_FOR_HUMAN", stepName: "open-more", needsHuman }),
    });

    expect(statusDetail(waiting)).toBe("open-more");
    expect(statusExplanation(waiting)).toBe("Solve the captcha in the worker's browser window.");
  });

  it("gives the reason and detail of a manual track", () => {
    const manual = track({
      job: job({ status: "MANUAL", manual: { reason: "dead_link", detail: "Track removed." } }),
    });

    expect(statusDetail(manual)).toBe("dead link");
    expect(statusExplanation(manual)).toBe("Track removed.");
  });

  it("gives the error of a failed job and the file of a downloaded one", () => {
    expect(
      statusExplanation(track({ job: job({ status: "FAILED", error: "Browser closed" }) })),
    ).toBe("Browser closed");
    expect(statusExplanation(track({ download }))).toBe("Artist - Track.mp3");
    expect(statusDetail(track({ download }))).toBeNull();
  });
});

describe("nativeProgress and progressSummary", () => {
  it("counts only native tracks, by where they stand", () => {
    const progress = nativeProgress([
      track({ download }),
      track({ job: job({ status: "QUEUED" }) }),
      track({ job: job({ status: "RUNNING", stepName: "download" }) }),
      track({ job: job({ status: "WAITING_FOR_HUMAN", needsHuman }) }),
      track({ job: job({ status: "MANUAL", manual: { reason: "file_gone", detail: null } }) }),
      track({ job: job({ status: "FAILED", error: "x" }) }),
      track(),
      track({ classification: "gate", job: job({ status: "RUNNING" }) }),
      track({ classification: "buy" }),
    ]);

    expect(progress).toEqual({
      native: 7,
      downloaded: 1,
      active: 2,
      needsYou: 1,
      manual: 1,
      failed: 1,
    });
    expect(progressSummary(progress)).toBe(
      "Downloaded 1 of 7 native tracks · 2 in progress · 1 needs you · 1 manual · 1 failed",
    );
  });

  it("keeps the summary short when nothing else is going on", () => {
    expect(progressSummary(nativeProgress([track({ download })]))).toBe(
      "Downloaded 1 of 1 native track",
    );
    expect(progressSummary(nativeProgress([track({ classification: "buy" })]))).toBe(
      "No native tracks in this playlist.",
    );
  });

  it("agrees in number", () => {
    const two = [
      track({ job: job({ status: "WAITING_FOR_HUMAN", needsHuman }) }),
      track({ job: job({ status: "WAITING_FOR_HUMAN", needsHuman }) }),
    ];

    expect(progressSummary(nativeProgress(two))).toBe(
      "Downloaded 0 of 2 native tracks · 2 need you",
    );
  });
});

describe("runResultMessage", () => {
  const nothing = { runId: null, queued: 0, resumed: 0, alreadyDownloaded: 0, alreadyActive: 0 };

  it.each([
    [{ ...nothing, queued: 3 }, "Queued 3 tracks."],
    [{ ...nothing, queued: 1 }, "Queued 1 track."],
    [{ ...nothing, resumed: 1 }, "Retrying 1 track that needed you."],
    [{ ...nothing, queued: 2, resumed: 1 }, "Queued 2 tracks. Retrying 1 track that needed you."],
    [{ ...nothing, alreadyActive: 2, alreadyDownloaded: 1 }, "2 tracks already in progress."],
    [{ ...nothing, alreadyDownloaded: 4 }, "Nothing to run: every native track is downloaded."],
    [nothing, "Nothing to run: this playlist has no native tracks."],
  ])("%j -> %s", (result, message) => {
    expect(runResultMessage(result)).toBe(message);
  });
});
