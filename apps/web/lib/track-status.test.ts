import { describe, expect, it } from "vitest";
import type { TrackDto, TrackJobDto } from "./api-schemas";
import {
  cancelResultMessage,
  downloadProgress,
  failureGroups,
  progressSummary,
  runResultMessage,
  statusDetail,
  statusExplanation,
  statusReason,
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

  it("labels a DRM-only track as such", () => {
    const manual = track({
      classification: "buy",
      job: job({ status: "MANUAL", manual: { reason: "drm_protected", detail: null } }),
    });

    expect(statusDetail(manual)).toBe("DRM protected");
  });

  it("gives the error of a failed job and the file of a downloaded one", () => {
    expect(
      statusExplanation(track({ job: job({ status: "FAILED", error: "Browser closed" }) })),
    ).toBe("Browser closed");
    expect(statusExplanation(track({ download }))).toBe("Artist - Track.mp3");
    expect(statusDetail(track({ download }))).toBeNull();
  });
});

describe("downloadProgress and progressSummary", () => {
  it("counts every track, whatever its classification, by where it stands", () => {
    const progress = downloadProgress([
      track({ download }),
      track({ job: job({ status: "QUEUED" }) }),
      track({ job: job({ status: "RUNNING", stepName: "download" }) }),
      track({ job: job({ status: "WAITING_FOR_HUMAN", needsHuman }) }),
      track({ job: job({ status: "MANUAL", manual: { reason: "file_gone", detail: null } }) }),
      track({ job: job({ status: "FAILED", error: "x" }) }),
      track(),
      track({ classification: "gate", job: job({ status: "RUNNING" }) }),
      track({ classification: "buy" }),
      track({ classification: "none", job: job({ status: "CANCELLED" }) }),
    ]);

    expect(progress).toEqual({
      total: 10,
      downloaded: 1,
      active: 3,
      queued: 1,
      running: 2,
      needsYou: 1,
      manual: 1,
      failed: 1,
      cancelled: 1,
    });
    expect(progressSummary(progress)).toBe(
      "Downloaded 1 of 10 tracks · 3 in progress · 1 needs you · 1 manual · 1 failed · 1 cancelled",
    );
  });

  it("keeps the summary short when nothing else is going on", () => {
    expect(progressSummary(downloadProgress([track({ download })]))).toBe(
      "Downloaded 1 of 1 track",
    );
    expect(progressSummary(downloadProgress([]))).toBe("No tracks in this playlist.");
  });

  it("agrees in number", () => {
    const two = [
      track({ job: job({ status: "WAITING_FOR_HUMAN", needsHuman }) }),
      track({ job: job({ status: "WAITING_FOR_HUMAN", needsHuman }) }),
    ];

    expect(progressSummary(downloadProgress(two))).toBe("Downloaded 0 of 2 tracks · 2 need you");
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
    [{ ...nothing, alreadyDownloaded: 4 }, "Nothing to run: every track is downloaded."],
    [nothing, "Nothing to run: this playlist has no tracks."],
  ])("%j -> %s", (result, message) => {
    expect(runResultMessage(result)).toBe(message);
  });
});

describe("statusReason", () => {
  it("spells out why a track failed, is manual, or was cancelled", () => {
    expect(
      statusReason(track({ job: job({ status: "FAILED", error: "yt-dlp needs ffmpeg." }) })),
    ).toEqual({ tone: "danger", text: "yt-dlp needs ffmpeg." });
    expect(
      statusReason(
        track({
          job: job({
            status: "MANUAL",
            manual: { reason: "drm_protected", detail: "Only streamed DRM-protected." },
          }),
        }),
      ),
    ).toEqual({ tone: "manual", text: "Only streamed DRM-protected." });
    expect(statusReason(track({ job: job({ status: "CANCELLED" }) }))).toMatchObject({
      tone: "muted",
      text: expect.stringContaining("Download tracks") as unknown,
    });
  });

  it("is null for everything else, including a failed job with no reason", () => {
    expect(statusReason(track())).toBeNull();
    expect(statusReason(track({ download }))).toBeNull();
    expect(statusReason(track({ job: job({ status: "RUNNING" }) }))).toBeNull();
    expect(statusReason(track({ job: job({ status: "FAILED", error: null }) }))).toBeNull();
  });
});

describe("failureGroups", () => {
  it("groups failed tracks by reason, most common first, ties in playlist order", () => {
    const failed = (error: string | null) => track({ job: job({ status: "FAILED", error }) });

    expect(
      failureGroups([
        failed("Login expired."),
        failed("ffmpeg missing."),
        failed("ffmpeg missing."),
        failed(null),
        track({ download }),
        track({ download, job: job({ status: "FAILED", error: "old" }) }),
      ]),
    ).toEqual([
      { message: "ffmpeg missing.", count: 2 },
      { message: "Login expired.", count: 1 },
      { message: "No reason was recorded.", count: 1 },
    ]);
  });

  it("is empty when nothing failed", () => {
    expect(failureGroups([track(), track({ download })])).toEqual([]);
  });
});

describe("cancelResultMessage", () => {
  it.each([
    [
      { cancelled: 5, running: 1 },
      "Cancelled 5 tracks. The track downloading now will finish; nothing starts after.",
    ],
    [{ cancelled: 1, running: 0 }, "Cancelled 1 track."],
    [
      { cancelled: 0, running: 1 },
      "Nothing was waiting. The track downloading now will finish; nothing starts after.",
    ],
    [{ cancelled: 0, running: 0 }, "Nothing was queued."],
  ])("%j -> %s", (result, message) => {
    expect(cancelResultMessage(result)).toBe(message);
  });
});
