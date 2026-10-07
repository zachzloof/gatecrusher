"use client";

import { FolderArchive, FolderOpen, Play, Square } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  apiErrorSchema,
  cancelRunResponseSchema,
  runResponseSchema,
  type TrackDto,
} from "@/lib/api-schemas";
import { useDesktop } from "@/lib/desktop";
import { formatBytes } from "@/lib/format";
import {
  cancelResultMessage,
  downloadProgress,
  failureGroups,
  progressSummary,
  runResultMessage,
  type DownloadProgress,
} from "@/lib/track-status";
import { cn } from "@/lib/utils";

type Outcome =
  | { kind: "idle" }
  | { kind: "pending"; action: "start" | "cancel" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string; needsAccount: boolean };

type ActionResult =
  { ok: true; message: string } | { ok: false; message: string; needsAccount?: boolean };

/** POST starts a run, DELETE cancels the queue; both answer with a short message. */
async function callRuns(playlistId: string, method: "POST" | "DELETE"): Promise<ActionResult> {
  try {
    const response = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/runs`, {
      method,
    });
    const body: unknown = await response.json();

    if (response.ok) {
      if (method === "POST") {
        const started = runResponseSchema.safeParse(body);
        if (started.success) return { ok: true, message: runResultMessage(started.data) };
      } else {
        const cancelled = cancelRunResponseSchema.safeParse(body);
        if (cancelled.success) return { ok: true, message: cancelResultMessage(cancelled.data) };
      }
    } else {
      const failure = apiErrorSchema.safeParse(body);
      if (failure.success) {
        return {
          ok: false,
          message: failure.data.error.message,
          needsAccount: failure.data.error.code === "soundcloud_not_connected",
        };
      }
    }
    return { ok: false, message: "The server sent an unexpected response. Try again." };
  } catch {
    // fetch rejected or the body was not JSON: the server is not reachable.
    return {
      ok: false,
      message: "Could not reach the server. Check it is running, then try again.",
    };
  }
}

/** Segments in the order a track moves through them, done work first. */
const SEGMENTS: readonly { key: keyof DownloadProgress; className: string }[] = [
  { key: "downloaded", className: "bg-ok" },
  { key: "manual", className: "bg-manual" },
  { key: "failed", className: "bg-danger" },
  { key: "cancelled", className: "bg-text-faint" },
  { key: "needsYou", className: "bg-accent" },
  { key: "running", className: "bg-info" },
  { key: "queued", className: "bg-info/40" },
];

/**
 * How far through the playlist the downloads are. Colours only repeat what the summary
 * line beside it says in words.
 */
function ProgressTrack({ progress, summary }: { progress: DownloadProgress; summary: string }) {
  const settled = progress.downloaded + progress.manual + progress.failed + progress.cancelled;
  return (
    <div
      role="progressbar"
      aria-label="Playlist progress"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={settled}
      aria-valuetext={summary}
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      {progress.total > 0 &&
        SEGMENTS.map(({ key, className }) =>
          progress[key] > 0 ? (
            <div
              key={key}
              className={cn(
                "h-full transition-[width] duration-150 ease-out motion-reduce:transition-none",
                className,
              )}
              style={{ width: `${(progress[key] / progress.total) * 100}%` }}
            />
          ) : null,
        )}
    </div>
  );
}

const SHOWN_FAILURE_GROUPS = 3;

/** Why tracks failed, grouped: one reason shared by many tracks is one thing to fix. */
function Failures({ tracks }: { tracks: readonly TrackDto[] }) {
  const groups = failureGroups(tracks);
  if (groups.length === 0) return null;
  const hidden = groups.length - SHOWN_FAILURE_GROUPS;
  return (
    <div className="basis-full border-t border-border pt-2">
      <p
        aria-hidden="true"
        className="mb-1 text-xs font-medium tracking-label text-text-muted uppercase"
      >
        Why tracks failed
      </p>
      <ul aria-label="Why tracks failed" className="grid gap-1 text-13">
        {groups.slice(0, SHOWN_FAILURE_GROUPS).map((group) => (
          <li key={group.message} className="flex gap-2 border-l-2 border-l-danger pl-2">
            <span className="shrink-0 font-mono text-xs leading-5 text-danger tabular-nums">
              {`${group.count}×`}
            </span>
            <span className="min-w-0 break-words text-text">{group.message}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="mt-1 text-xs text-text-muted">
          {`${hidden} more ${hidden === 1 ? "reason" : "reasons"}: see the tracks marked Failed below.`}
        </p>
      )}
    </div>
  );
}

interface RunBarProps {
  playlistId: string;
  tracks: readonly TrackDto[];
  /** Called once a run was started or cancelled, so the page can show the new statuses. */
  onChanged: () => void;
  /** The playlist's folder under downloads/, opened by "Open folder" in the desktop app. */
  downloadsFolder: string;
}

/**
 * The playlist's one primary action, its Cancel, the zip of what it has produced, and how
 * far it has got. Clicking "Download tracks" again is how failed, cancelled or paused
 * tracks are retried, so it stays available while a run is in progress.
 */
export function RunBar({ playlistId, tracks, onChanged, downloadsFolder }: RunBarProps) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const desktop = useDesktop();
  const progress = downloadProgress(tracks);
  const summary = progressSummary(progress);

  const pending = outcome.kind === "pending";
  const nothingLeft = progress.downloaded === progress.total;
  const downloaded = tracks.filter((track) => track.download !== null);
  const downloadedBytes = downloaded.reduce(
    (total, track) => total + (track.download?.sizeBytes ?? 0),
    0,
  );

  async function act(action: "start" | "cancel"): Promise<void> {
    if (pending) return;
    setOutcome({ kind: "pending", action });
    const result = await callRuns(playlistId, action === "start" ? "POST" : "DELETE");
    setOutcome(
      result.ok
        ? { kind: "done", message: result.message }
        : { kind: "error", message: result.message, needsAccount: result.needsAccount === true },
    );
    if (result.ok) onChanged();
  }

  return (
    <section
      aria-label="Downloads"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-border bg-surface-1 px-3 py-2.5"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => void act("start")}
          disabled={pending || nothingLeft}
        >
          <Play aria-hidden="true" />
          {outcome.kind === "pending" && outcome.action === "start"
            ? "Starting…"
            : "Download tracks"}
        </Button>
        {/* Always rendered, so the bar does not shift when a run starts or ends. */}
        <Button onClick={() => void act("cancel")} disabled={pending || progress.queued === 0}>
          <Square aria-hidden="true" />
          {outcome.kind === "pending" && outcome.action === "cancel" ? "Cancelling…" : "Cancel"}
        </Button>
        {downloaded.length > 0 ? (
          <Button asChild>
            <a href={`/api/playlists/${encodeURIComponent(playlistId)}/archive`} download>
              <FolderArchive aria-hidden="true" />
              {`Download zip · ${downloaded.length} ${downloaded.length === 1 ? "file" : "files"}, ${formatBytes(downloadedBytes)}`}
            </a>
          </Button>
        ) : (
          <Button disabled>
            <FolderArchive aria-hidden="true" />
            Download zip
          </Button>
        )}
        {desktop !== null && (
          <Button
            onClick={() => void desktop.openDownloads(downloadsFolder)}
            disabled={downloaded.length === 0}
          >
            <FolderOpen aria-hidden="true" />
            Open folder
          </Button>
        )}
      </div>
      <div className="grid min-w-0 flex-1 basis-full gap-1.5 text-13 sm:basis-0">
        <ProgressTrack progress={progress} summary={summary} />
        <p aria-live="polite" className="font-mono text-xs leading-5 text-text-muted tabular-nums">
          {summary}
        </p>
        <p
          aria-live="polite"
          role={outcome.kind === "error" ? "alert" : undefined}
          className={cn("min-h-5", outcome.kind === "error" ? "text-danger" : "text-text")}
        >
          {(outcome.kind === "done" || outcome.kind === "error") && outcome.message}
          {outcome.kind === "error" && outcome.needsAccount && (
            <>
              {" "}
              <Link
                href="/connect"
                className="text-text underline underline-offset-2 hover:text-info"
              >
                Connect SoundCloud
              </Link>
            </>
          )}
        </p>
      </div>
      <Failures tracks={tracks} />
    </section>
  );
}
