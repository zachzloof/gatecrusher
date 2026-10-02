"use client";

import Link from "next/link";
import { Artwork } from "@/components/artwork";
import { ErrorState, RowsSkeleton } from "@/components/data-states";
import { EmptyState } from "@/components/empty-state";
import { statusLabel } from "@/components/status-badge";
import { listPlaylistsResponseSchema, type PlaylistSummaryDto } from "@/lib/api-schemas";
import { useApi } from "@/lib/use-api";
import { TRACK_CLASSIFICATIONS } from "@gatecrusher/core";

function PlaylistRow({ playlist }: { playlist: PlaylistSummaryDto }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        href={`/playlists/${playlist.id}`}
        className="flex min-h-12 items-center gap-3 px-3 py-2 transition-colors duration-150 ease-out hover:bg-surface-2"
      >
        <Artwork url={playlist.artworkUrl} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-text" title={playlist.title}>
            {playlist.title}
          </span>
          <span className="block truncate text-xs text-text-muted">
            {playlist.owner ?? "Unknown owner"}
            <span className="font-mono tabular-nums">
              {` · ${playlist.trackCount} ${playlist.trackCount === 1 ? "track" : "tracks"}`}
            </span>
          </span>
        </span>
        <dl className="hidden shrink-0 gap-4 text-xs text-text-muted md:flex">
          {TRACK_CLASSIFICATIONS.map((classification) => (
            <div key={classification} className="flex items-baseline gap-1.5">
              <dt>{statusLabel(classification)}</dt>
              <dd className="font-mono text-text tabular-nums">
                {playlist.counts[classification]}
              </dd>
            </div>
          ))}
        </dl>
      </Link>
    </li>
  );
}

export function PlaylistsView() {
  const { state, reload } = useApi("/api/playlists", listPlaylistsResponseSchema);

  switch (state.status) {
    case "loading":
      return <RowsSkeleton rows={4} label="Loading playlists" />;
    case "error":
      return (
        <ErrorState title="Could not load the playlists" error={state.error} onRetry={reload} />
      );
    case "ok":
      if (state.data.playlists.length === 0) {
        return (
          <EmptyState>
            No playlists yet. Add a SoundCloud playlist to classify its tracks.
          </EmptyState>
        );
      }
      return (
        <ul
          aria-label="Playlists"
          className="rounded-panel border border-border bg-surface-1 text-13"
        >
          {state.data.playlists.map((playlist) => (
            <PlaylistRow key={playlist.id} playlist={playlist} />
          ))}
        </ul>
      );
  }
}
