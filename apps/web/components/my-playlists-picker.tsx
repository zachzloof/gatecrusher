"use client";

import { Lock, Music, Search } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { ErrorState } from "@/components/data-states";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/ui/input";
import {
  myPlaylistsResponseSchema,
  type ListingReport,
  type MyPlaylistDto,
} from "@/lib/api-schemas";
import { safeHref } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";

interface MyPlaylistsPickerProps {
  /** Called with the playlist to add. */
  onPick: (playlist: MyPlaylistDto) => void;
  /** The playlist being added right now, if any; every tile is held while it is. */
  busyId: string | null;
}

const EMPTY: readonly MyPlaylistDto[] = [];

function matches(playlist: MyPlaylistDto, query: string): boolean {
  const haystack = `${playlist.title} ${playlist.owner ?? ""}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

/** A square cover, or a placeholder of the same size when the playlist has none. */
function Cover({ url, busy }: { url: string | null; busy: boolean }) {
  const src = safeHref(url);
  return (
    <span className="relative block aspect-square w-full overflow-hidden rounded-control bg-surface-2">
      {src === undefined ? (
        <span
          aria-hidden="true"
          className="flex size-full items-center justify-center text-text-faint"
        >
          <Music className="size-8" />
        </span>
      ) : (
        // A plain <img>: remote SoundCloud CDN covers that next/image would have to
        // fetch and re-encode server-side.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover transition-transform duration-150 ease-out group-hover:scale-[1.04] group-focus-visible:scale-[1.04]"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "absolute right-1.5 bottom-1.5 rounded-control border border-border bg-surface-1/95 px-1.5 py-0.5 text-xs font-medium text-text transition-opacity duration-150 ease-out",
          busy
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      >
        {busy ? "Reading…" : "Add"}
      </span>
    </span>
  );
}

function PlaylistTile({
  playlist,
  busy,
  held,
  onPick,
}: {
  playlist: MyPlaylistDto;
  busy: boolean;
  held: boolean;
  onPick: () => void;
}) {
  const meta = [
    `${playlist.trackCount} ${playlist.trackCount === 1 ? "track" : "tracks"}`,
    playlist.liked && playlist.owner !== null ? `by ${playlist.owner}` : null,
    playlist.isPrivate ? "Private" : null,
  ].filter((part) => part !== null);

  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        disabled={held}
        aria-busy={busy}
        aria-label={`Add ${playlist.title}`}
        className={cn(
          "group flex w-full flex-col gap-2 rounded-panel border border-transparent p-2 text-left transition-colors duration-150 ease-out",
          "hover:border-border hover:bg-surface-2 focus-visible:border-border",
          "disabled:cursor-progress",
          held && !busy && "opacity-50",
        )}
      >
        <Cover url={playlist.artworkUrl} busy={busy} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span
            className="line-clamp-2 text-13 leading-4 font-medium text-text"
            title={playlist.title}
          >
            {playlist.title}
          </span>
          <span className="flex items-center gap-1 font-mono text-xs tabular-nums text-text-muted">
            {playlist.isPrivate && (
              <Lock aria-hidden="true" className="size-3 shrink-0 text-text-faint" />
            )}
            <span className="truncate">{meta.join(" · ")}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** One line per SoundCloud listing: what it returned and what could not be used. */
function ListingsDetail({ listings }: { listings: ListingReport[] }) {
  return (
    <details className="text-13 text-text-muted">
      <summary className="cursor-pointer">Where these came from</summary>
      <pre className="mt-2 rounded-control bg-surface-2 p-3 font-mono text-xs break-words whitespace-pre-wrap text-text">
        {listings
          .map((listing) =>
            listing.items === null
              ? `${listing.path}: SoundCloud has no such listing`
              : `${listing.path}: ${listing.items} items, ${listing.playlists} playlists, ${listing.unusable} unusable, ${listing.other} other`,
          )
          .join("\n")}
      </pre>
    </details>
  );
}

function TilesSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading your playlists"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 p-2">
          <div className="aspect-square w-full rounded-control bg-surface-2" />
          <div className="h-3 w-4/5 rounded-control bg-surface-2" />
          <div className="h-3 w-2/5 rounded-control bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

/**
 * The connected SoundCloud account's playlists as a searchable grid of covers. Picking
 * one hands it to the parent, which adds it the same way a pasted URL is added.
 */
export function MyPlaylistsPicker({ onPick, busyId }: MyPlaylistsPickerProps) {
  const { state, reload } = useApi("/api/soundcloud-account/playlists", myPlaylistsResponseSchema);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const countId = useId();

  const trimmed = query.trim().toLowerCase();
  const playlists = useMemo(() => (state.status === "ok" ? state.data.playlists : EMPTY), [state]);
  const listings = state.status === "ok" ? state.data.listings : [];
  const shown = useMemo(
    () => (trimmed === "" ? playlists : playlists.filter((playlist) => matches(playlist, trimmed))),
    [playlists, trimmed],
  );

  if (state.status === "loading") return <TilesSkeleton />;

  if (state.status === "error") {
    // 409 is the one answer that is not a failure: nothing is connected yet.
    if (state.error.status === 409) {
      return (
        <EmptyState>
          No SoundCloud account is connected yet.{" "}
          <Link href="/connect" className="text-text underline underline-offset-4">
            Connect SoundCloud
          </Link>{" "}
          to pick from its playlists.
        </EmptyState>
      );
    }
    return (
      <ErrorState title="Could not load your playlists" error={state.error} onRetry={reload} />
    );
  }

  if (playlists.length === 0) {
    return (
      <div className="grid gap-3">
        <EmptyState>
          This account has no playlists yet. Make or like one on SoundCloud, then come back.
        </EmptyState>
        <ListingsDetail listings={listings} />
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-faint"
        />
        <Input
          id={searchId}
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search your playlists"
          aria-label="Search your playlists"
          aria-describedby={countId}
          className="pr-20 pl-9"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span
          id={countId}
          aria-live="polite"
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs tabular-nums text-text-muted"
        >
          {trimmed === "" ? playlists.length : `${shown.length} of ${playlists.length}`}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="px-2 py-10 text-center text-13 text-text-muted">
          No playlists match “{query.trim()}”.
        </p>
      ) : (
        <ul
          aria-label="Your playlists"
          className="-mx-2 grid max-h-[55vh] grid-cols-2 gap-1 overflow-y-auto px-2 py-1 sm:grid-cols-3 md:grid-cols-4"
        >
          {shown.map((playlist) => (
            <PlaylistTile
              key={playlist.soundcloudId}
              playlist={playlist}
              busy={busyId === playlist.soundcloudId}
              held={busyId !== null}
              onPick={() => onPick(playlist)}
            />
          ))}
        </ul>
      )}
      <ListingsDetail listings={listings} />
    </div>
  );
}
