"use client";

import { playlistSlug, type IngestSource } from "@gatecrusher/core";
import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorState, RowsSkeleton } from "@/components/data-states";
import { PausedTracks } from "@/components/paused-tracks";
import { RunBar } from "@/components/run-bar";
import { TracksTable } from "@/components/tracks-table";
import { playlistDetailResponseSchema, type PlaylistDto } from "@/lib/api-schemas";
import { safeHref } from "@/lib/format";
import { downloadProgress } from "@/lib/track-status";
import { useApi } from "@/lib/use-api";

/** While tracks are queued or running, the page asks again this often. */
const POLL_INTERVAL_MS = 3_000;

const SOURCE_LABELS: Record<IngestSource, string> = {
  api_v2: "SoundCloud API",
  yt_dlp: "yt-dlp fallback",
};

function BackLink() {
  return (
    <Link
      href="/playlists"
      className="mb-3 inline-flex items-center gap-1.5 text-13 text-text-muted transition-colors duration-150 ease-out hover:text-text"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Playlists
    </Link>
  );
}

function PlaylistHeader({ playlist, trackCount }: { playlist: PlaylistDto; trackCount: number }) {
  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <h1 className="min-w-0 text-xl font-semibold break-words text-text">{playlist.title}</h1>
        <a
          href={safeHref(playlist.soundcloudUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border bg-surface-2 px-2.5 text-13 text-text transition-colors duration-150 ease-out hover:bg-surface-1"
        >
          Open on SoundCloud
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </div>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-13 text-text-muted">
        <div className="flex gap-1.5">
          <dt className="sr-only">Owner</dt>
          <dd>{playlist.owner ?? "Unknown owner"}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="sr-only">Tracks</dt>
          <dd className="font-mono tabular-nums">
            {trackCount} {trackCount === 1 ? "track" : "tracks"}
          </dd>
        </div>
        {playlist.ingestSource !== null && (
          <div className="flex gap-1.5">
            <dt>Source</dt>
            <dd className="text-text">{SOURCE_LABELS[playlist.ingestSource]}</dd>
          </div>
        )}
        {playlist.lastIngestedAt !== null && (
          <div className="flex gap-1.5">
            <dt>Read</dt>
            <dd className="font-mono text-xs leading-5 tabular-nums">
              <time dateTime={playlist.lastIngestedAt}>
                {new Date(playlist.lastIngestedAt).toLocaleString()}
              </time>
            </dd>
          </div>
        )}
      </dl>
    </header>
  );
}

function Notice({ children }: { children: string }) {
  return (
    <p className="mb-3 rounded-panel border border-border bg-surface-1 px-3 py-2 text-13 text-text-muted">
      {children}
    </p>
  );
}

interface PlaylistViewProps {
  playlistId: string;
  /** Tracks the ingest that led here could not read. Only known right after adding. */
  skippedCount: number;
}

export function PlaylistView({ playlistId, skippedCount }: PlaylistViewProps) {
  const { state, reload, refresh } = useApi(
    `/api/playlists/${encodeURIComponent(playlistId)}`,
    playlistDetailResponseSchema,
  );

  // Tracks ticked in the table: the zip is limited to them while any are ticked.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // Live statuses arrive over SSE from slice 4. Until then, poll while work is going on.
  const active = state.status === "ok" && downloadProgress(state.data.tracks).active > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  switch (state.status) {
    case "loading":
      return (
        <>
          <BackLink />
          <div aria-hidden="true" className="mb-4">
            <div className="h-7 w-64 max-w-full rounded-control bg-surface-2" />
            <div className="mt-2 h-4 w-80 max-w-full rounded-control bg-surface-1" />
          </div>
          <RowsSkeleton label="Loading tracks" />
        </>
      );
    case "error":
      return (
        <>
          <BackLink />
          <ErrorState
            title={
              state.error.status === 404
                ? "This playlist is not in Gatecrusher"
                : "Could not load the playlist"
            }
            error={state.error}
            onRetry={reload}
          />
        </>
      );
    case "ok": {
      const { playlist, tracks } = state.data;
      return (
        <>
          <BackLink />
          <PlaylistHeader playlist={playlist} trackCount={tracks.length} />
          {playlist.ingestSource === "yt_dlp" && (
            <Notice>
              SoundCloud&apos;s API was unavailable, so this playlist was read with yt-dlp. yt-dlp
              reports no download or buy links, so every track shows as No download. Add the
              playlist again later to classify it.
            </Notice>
          )}
          {skippedCount > 0 && (
            <Notice>
              {`${skippedCount} ${skippedCount === 1 ? "track" : "tracks"} in this playlist could not be read (private, removed or blocked in this region) and ${skippedCount === 1 ? "is" : "are"} not listed.`}
            </Notice>
          )}
          <RunBar
            playlistId={playlist.id}
            tracks={tracks}
            selected={selected}
            onChanged={refresh}
            downloadsFolder={playlistSlug(playlist.soundcloudUrl, playlist.title)}
          />
          <PausedTracks tracks={tracks} />
          <TracksTable tracks={tracks} selected={selected} onSelectedChange={setSelected} />
        </>
      );
    }
  }
}
