"use client";

import { Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiErrorSchema, runNativeResponseSchema, type TrackDto } from "@/lib/api-schemas";
import { nativeProgress, progressSummary, runResultMessage } from "@/lib/track-status";
import { cn } from "@/lib/utils";

type Outcome =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "started"; message: string }
  | { kind: "error"; message: string };

type StartResult = { ok: true; message: string } | { ok: false; message: string };

async function startRun(playlistId: string): Promise<StartResult> {
  try {
    const response = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/runs`, {
      method: "POST",
    });
    const body: unknown = await response.json();

    if (response.ok) {
      const started = runNativeResponseSchema.safeParse(body);
      if (started.success) return { ok: true, message: runResultMessage(started.data) };
    } else {
      const failure = apiErrorSchema.safeParse(body);
      if (failure.success) return { ok: false, message: failure.data.error.message };
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

interface RunNativeBarProps {
  playlistId: string;
  tracks: readonly TrackDto[];
  /** Called once a run was started, so the page can show the new statuses. */
  onStarted: () => void;
}

/**
 * The playlist's one primary action. Clicking it again is how paused tracks are
 * retried in this slice, so it stays available while a run is in progress.
 */
export function RunNativeBar({ playlistId, tracks, onStarted }: RunNativeBarProps) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const progress = nativeProgress(tracks);

  const starting = outcome.kind === "starting";
  const nothingLeft = progress.downloaded === progress.native;

  async function handleClick(): Promise<void> {
    if (starting) return;
    setOutcome({ kind: "starting" });
    const result = await startRun(playlistId);
    setOutcome(
      result.ok
        ? { kind: "started", message: result.message }
        : { kind: "error", message: result.message },
    );
    if (result.ok) onStarted();
  }

  return (
    <section
      aria-label="Native downloads"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-border bg-surface-1 px-3 py-2.5"
    >
      <Button
        variant="primary"
        onClick={() => void handleClick()}
        disabled={starting || nothingLeft}
      >
        <Play aria-hidden="true" />
        {starting ? "Starting…" : "Run native tracks"}
      </Button>
      <div className="min-w-0 flex-1 basis-full text-13 sm:basis-0">
        <p aria-live="polite" className="font-mono text-xs leading-5 text-text-muted tabular-nums">
          {progressSummary(progress)}
        </p>
        <p
          aria-live="polite"
          role={outcome.kind === "error" ? "alert" : undefined}
          className={cn("min-h-5", outcome.kind === "error" ? "text-danger" : "text-text")}
        >
          {(outcome.kind === "started" || outcome.kind === "error") && outcome.message}
        </p>
      </div>
    </section>
  );
}
