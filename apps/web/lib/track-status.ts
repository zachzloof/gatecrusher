// What a track's job state means for the playlist page. Pure, so it is unit-tested
// without rendering anything.
import type { JobStatus, ManualReason } from "@gatecrusher/core";
import type { CancelRunResponse, RunResponse, TrackDto } from "./api-schemas";

const MANUAL_REASON_LABELS: Record<ManualReason, string> = {
  dead_link: "dead link",
  file_gone: "file gone",
  account_required: "account required",
  drm_protected: "DRM protected",
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

/** Why a track ended where it did, shown under its title: why it failed, or why it is manual. */
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
    case "CANCELLED":
      return "Cancelled before it started. Click Download tracks to queue it again.";
    case "QUEUED":
    case "RUNNING":
    case null:
      return undefined;
  }
}

export interface StatusReason {
  tone: "danger" | "manual" | "muted";
  text: string;
}

/** The reason to print under a track that failed, is manual, or was cancelled. */
export function statusReason(track: TrackDto): StatusReason | null {
  const text = statusExplanation(track);
  if (text === undefined || text === "") return null;
  switch (trackStatus(track)) {
    case "FAILED":
      return { tone: "danger", text };
    case "MANUAL":
      return { tone: "manual", text };
    case "CANCELLED":
      return { tone: "muted", text };
    case "SUCCEEDED":
    case "WAITING_FOR_HUMAN":
    case "QUEUED":
    case "RUNNING":
    case null:
      // A download names its file in the tooltip; a paused track has its own card.
      return null;
  }
}

export interface DownloadProgress {
  total: number;
  downloaded: number;
  /** Queued or running. */
  active: number;
  queued: number;
  running: number;
  needsYou: number;
  manual: number;
  failed: number;
  cancelled: number;
}

/** Where the playlist's tracks stand. */
export function downloadProgress(tracks: readonly TrackDto[]): DownloadProgress {
  const progress: DownloadProgress = {
    total: 0,
    downloaded: 0,
    active: 0,
    queued: 0,
    running: 0,
    needsYou: 0,
    manual: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const track of tracks) {
    progress.total += 1;
    switch (trackStatus(track)) {
      case "SUCCEEDED":
        progress.downloaded += 1;
        break;
      case "QUEUED":
        progress.active += 1;
        progress.queued += 1;
        break;
      case "RUNNING":
        progress.active += 1;
        progress.running += 1;
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
      case "CANCELLED":
        progress.cancelled += 1;
        break;
      case null:
        break;
    }
  }
  return progress;
}

/** "Downloaded 2 of 5 tracks · 1 in progress · 1 needs you". */
export function progressSummary(progress: DownloadProgress): string {
  if (progress.total === 0) return "No tracks in this playlist.";
  const parts = [
    `Downloaded ${progress.downloaded} of ${progress.total} ${progress.total === 1 ? "track" : "tracks"}`,
  ];
  if (progress.active > 0) parts.push(`${progress.active} in progress`);
  if (progress.needsYou > 0)
    parts.push(`${progress.needsYou} ${progress.needsYou === 1 ? "needs" : "need"} you`);
  if (progress.manual > 0) parts.push(`${progress.manual} manual`);
  if (progress.failed > 0) parts.push(`${progress.failed} failed`);
  if (progress.cancelled > 0) parts.push(`${progress.cancelled} cancelled`);
  return parts.join(" · ");
}

export interface FailureGroup {
  /** The reason the worker recorded, word for word. */
  message: string;
  count: number;
}

/**
 * The playlist's failed tracks grouped by reason, most common first. One reason shared by
 * many tracks (yt-dlp missing, an expired login) is usually one thing to fix.
 */
export function failureGroups(tracks: readonly TrackDto[]): FailureGroup[] {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    if (trackStatus(track) !== "FAILED") continue;
    const message = track.job?.error ?? "No reason was recorded.";
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  // Map keeps first-seen order, and the sort is stable: ties stay in playlist order.
  return [...counts]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count);
}

const tracks = (count: number): string => `${count} ${count === 1 ? "track" : "tracks"}`;

/** What clicking "Download tracks" did, in plain words. */
export function runResultMessage(result: RunResponse): string {
  const parts: string[] = [];
  if (result.queued > 0) parts.push(`Queued ${tracks(result.queued)}.`);
  if (result.resumed > 0) parts.push(`Retrying ${tracks(result.resumed)} that needed you.`);
  if (parts.length > 0) return parts.join(" ");
  if (result.alreadyActive > 0) return `${tracks(result.alreadyActive)} already in progress.`;
  if (result.alreadyDownloaded > 0) return "Nothing to run: every track is downloaded.";
  return "Nothing to run: this playlist has no tracks.";
}

/** What clicking "Cancel" did, in plain words. */
export function cancelResultMessage(result: CancelRunResponse): string {
  const running =
    result.running > 0
      ? ` The ${result.running === 1 ? "track" : "tracks"} downloading now will finish; nothing starts after.`
      : "";
  if (result.cancelled === 0) {
    return result.running > 0 ? `Nothing was waiting.${running}` : "Nothing was queued.";
  }
  return `Cancelled ${tracks(result.cancelled)}.${running}`;
}
