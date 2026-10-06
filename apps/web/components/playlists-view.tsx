"use client";

import Link from "next/link";
import { useState } from "react";
import { Artwork } from "@/components/artwork";
import { ErrorState, RowsSkeleton } from "@/components/data-states";
import { DeletePlaylistDialog } from "@/components/delete-playlist-dialog";
import { EmptyState } from "@/components/empty-state";
import { statusLabel } from "@/components/status-badge";
import {
  listPlaylistsResponseSchema,
  type DeletePlaylistResponse,
  type PlaylistSummaryDto,
} from "@/lib/api-schemas";
import { formatBytes } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { TRACK_CLASSIFICATIONS } from "@gatecrusher/core";

interface PlaylistRowProps {
  playlist: PlaylistSummaryDto;
  onDeleted: (removed: DeletePlaylistResponse) => void;
}

function PlaylistRow({ playlist, onDeleted }: PlaylistRowProps) {
  return (
    <li className="flex items-center border-b border-border pr-2 last:border-b-0">
      <Link
        href={`/playlists/${playlist.id}`}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 py-2 transition-colors duration-150 ease-out hover:bg-surface-2"
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
      <DeletePlaylistDialog playlist={playlist} onDeleted={onDeleted} />
    </li>
  );
}

/** "Deleted tekno and its 7 files (70.3 MB)." */
function deletedMessage(title: string, removed: DeletePlaylistResponse): string {
  if (removed.deletedFiles === 0) return `Deleted ${title}.`;
  const files = `${removed.deletedFiles} ${removed.deletedFiles === 1 ? "file" : "files"}`;
  return `Deleted ${title} and its ${files} (${formatBytes(removed.freedBytes)}).`;
}

export function PlaylistsView() {
  const { state, reload, refresh } = useApi("/api/playlists", listPlaylistsResponseSchema);
  const [notice, setNotice] = useState<string | null>(null);

  // Rendered in every state, so the message survives the reload that follows a delete.
  const noticeLine = (
    <p aria-live="polite" className="min-h-5 pb-2 text-13 text-text-muted">
      {notice}
    </p>
  );

  switch (state.status) {
    case "loading":
      return (
        <>
          {noticeLine}
          <RowsSkeleton rows={4} label="Loading playlists" />
        </>
      );
    case "error":
      return (
        <ErrorState title="Could not load the playlists" error={state.error} onRetry={reload} />
      );
    case "ok":
      if (state.data.playlists.length === 0) {
        return (
          <>
            {noticeLine}
            <EmptyState>
              No playlists yet. Add a SoundCloud playlist to classify its tracks.
            </EmptyState>
          </>
        );
      }
      return (
        <>
          {noticeLine}
          <ul
            aria-label="Playlists"
            className="rounded-panel border border-border bg-surface-1 text-13"
          >
            {state.data.playlists.map((playlist) => (
              <PlaylistRow
                key={playlist.id}
                playlist={playlist}
                onDeleted={(removed) => {
                  setNotice(deletedMessage(playlist.title, removed));
                  refresh();
                }}
              />
            ))}
          </ul>
        </>
      );
  }
}
