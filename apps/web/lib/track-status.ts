// What a track's job state means for the playlist page. Pure, so it is unit-tested
// without rendering anything.
import type { JobStatus, ManualReason } from "@gatecrusher/core";
import type { RunNativeResponse, TrackDto } from "./api-schemas";

const MANUAL_REASON_LABELS: Record<ManualReason, string> = {
  dead_link: "dead link",
  file_gone: "file gone",
  account_required: "account required",
  user_gave_up: "gave up",
};

/** The status to show for a track, or `null` when it has never been run. */
export function trackStatus(track: TrackDto): JobStatus | null {
  // A verified download is the fact that matters, whatever a later job did.
  if (track.download !== null) return "SUCCEEDED";
  return track.job?.status ?? null;
}

/** The short qualifier after the status label: the current step, or why it is manual. */
export function statusDetail(track: TrackDto): string | null {
  const status = trackStatus(track);
  if (status === "RUNNING" || status === "WAITING_FOR_HUMAN") return track.job?.stepName ?? null;
  if (status === "MANUAL") {
    const reason = track.job?.manual?.reason;
    return reason === undefined ? null : MANUAL_REASON_LABELS[reason];
  }
  return null;
}

/** The longer explanation behind a status, for a tooltip. */
export function statusExplanation(track: TrackDto): string | undefined {
  switch (trackStatus(track)) {
    case "SUCCEEDED":
      return track.download?.fileName;
    case "WAITING_FOR_HUMAN":
      return track.job?.needsHuman?.description;
    case "MANUAL":
      return track.job?.manual?.detail ?? undefined;
    case "FAILED":
      return track.job?.error ?? undefined;
    case "QUEUED":
    case "RUNNING":
    case null:
      return undefined;
  }
}

export interface NativeProgress {
  native: number;
  downloaded: number;
  /** Queued or running. */
  active: number;
  needsYou: number;
  manual: number;
  failed: number;
}

/** Where the playlist's native tracks stand. */
export function nativeProgress(tracks: readonly TrackDto[]): NativeProgress {
  const progress: NativeProgress = {
    native: 0,
    downloaded: 0,
    active: 0,
    needsYou: 0,
    manual: 0,
    failed: 0,
  };
  for (const track of tracks) {
    if (track.classification !== "native") continue;
    progress.native += 1;
    switch (trackStatus(track)) {
      case "SUCCEEDED":
        progress.downloaded += 1;
        break;
      case "QUEUED":
      case "RUNNING":
        progress.active += 1;
        break;
      case "WAITING_FOR_HUMAN":
        progress.needsYou += 1;
        break;
      case "MANUAL":
        progress.manual += 1;
        break;
      case "FAILED":
        progress.failed += 1;
        break;
      case null:
        break;
    }
  }
  return progress;
}

/** "Downloaded 2 of 5 native tracks · 1 in progress · 1 needs you". */
export function progressSummary(progress: NativeProgress): string {
  if (progress.native === 0) return "No native tracks in this playlist.";
  const parts = [
    `Downloaded ${progress.downloaded} of ${progress.native} native ${progress.native === 1 ? "track" : "tracks"}`,
  ];
  if (progress.active > 0) parts.push(`${progress.active} in progress`);
  if (progress.needsYou > 0)
    parts.push(`${progress.needsYou} ${progress.needsYou === 1 ? "needs" : "need"} you`);
  if (progress.manual > 0) parts.push(`${progress.manual} manual`);
  if (progress.failed > 0) parts.push(`${progress.failed} failed`);
  return parts.join(" · ");
}

const tracks = (count: number): string => `${count} ${count === 1 ? "track" : "tracks"}`;

/** What clicking "Download native tracks" did, in plain words. */
export function runResultMessage(result: RunNativeResponse): string {
  const parts: string[] = [];
  if (result.queued > 0) parts.push(`Queued ${tracks(result.queued)}.`);
  if (result.resumed > 0) parts.push(`Retrying ${tracks(result.resumed)} that needed you.`);
  if (parts.length > 0) return parts.join(" ");
  if (result.alreadyActive > 0) return `${tracks(result.alreadyActive)} already in progress.`;
  if (result.alreadyDownloaded > 0) return "Nothing to run: every native track is downloaded.";
  return "Nothing to run: this playlist has no native tracks.";
}
