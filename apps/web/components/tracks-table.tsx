"use client";

import { ArrowDown, ArrowUp, ExternalLink, Link2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Artwork } from "@/components/artwork";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge, statusLabel } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TrackDto } from "@/lib/api-schemas";
import { displayUrl, formatDuration, middleTruncate, safeHref } from "@/lib/format";
import {
  statusDetail,
  statusExplanation,
  statusReason,
  trackStatus,
  type StatusReason,
} from "@/lib/track-status";
import {
  CLASSIFICATION_FILTERS,
  countByClassification,
  DEFAULT_SORT,
  filterTracks,
  nextSort,
  sortTracks,
  type ClassificationFilter,
  type SortKey,
  type TrackSort,
} from "@/lib/tracks-view";
import { cn } from "@/lib/utils";

function filterLabel(filter: ClassificationFilter): string {
  return filter === "all" ? "All" : statusLabel(filter);
}

interface SortHeadProps {
  label: string;
  sortKey: SortKey;
  sort: TrackSort;
  onSort: (key: SortKey) => void;
  className?: string;
}

function SortHead({ label, sortKey, sort, onSort, className }: SortHeadProps) {
  const active = sort.key === sortKey;
  const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={className}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 rounded-control tracking-label uppercase transition-colors duration-150 ease-out hover:text-text",
          active && "text-text",
        )}
      >
        {label}
        {/* Always rendered so the header does not shift when the sort changes. */}
        <Arrow className={cn("size-3", !active && "invisible")} aria-hidden="true" />
      </button>
    </TableHead>
  );
}

const ICON_LINK =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors duration-150 ease-out hover:bg-surface-1 hover:text-text";

/** Where the track's job stands, or a dash when it has never been run. */
function RunStatus({ track, className }: { track: TrackDto; className?: string }) {
  const status = trackStatus(track);
  if (status === null) {
    return (
      <span aria-hidden="true" className="text-text-muted">
        —
      </span>
    );
  }
  return (
    <span title={statusExplanation(track)} className="flex min-w-0">
      <StatusBadge status={status} detail={statusDetail(track)} className={className} />
    </span>
  );
}

const REASON_TONE: Record<StatusReason["tone"], string> = {
  danger: "text-danger",
  manual: "text-manual",
  muted: "text-text-muted",
};

/** Why a track failed, is manual or was cancelled, in full: never only in a tooltip. */
function Reason({ track }: { track: TrackDto }) {
  const reason = statusReason(track);
  if (reason === null) return null;
  return (
    <p
      className={cn(
        "mt-0.5 max-w-prose text-xs leading-4 break-words whitespace-normal",
        REASON_TONE[reason.tone],
      )}
    >
      {reason.text}
    </p>
  );
}

/** The gate or store link for the high-quality download, or nothing for a native track. */
function hqDownloadHref(track: TrackDto): string | undefined {
  if (track.classification === "native") return undefined;
  return safeHref(track.purchaseUrl);
}

/**
 * Where to get the high-quality download: the gate or the store. Spelled out on wide
 * screens, an icon below; a dash when the track has no such link.
 */
function HqDownloadLink({ track }: { track: TrackDto }) {
  const href = hqDownloadHref(track);
  if (href === undefined) {
    return (
      <span aria-hidden="true" className="text-text-muted">
        —
      </span>
    );
  }
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={href}
        className="hidden min-w-0 truncate font-mono text-xs text-text-muted underline-offset-2 hover:text-text hover:underline xl:block"
      >
        {middleTruncate(displayUrl(href), 28)}
      </a>
      <HqDownloadIcon track={track} className="xl:hidden" />
    </>
  );
}

/** The same link as an icon only, or nothing when the track has none. */
function HqDownloadIcon({ track, className }: { track: TrackDto; className?: string }) {
  const href = hqDownloadHref(track);
  if (href === undefined) return null;
  const what = track.classification === "gate" ? "gate" : "store";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open the ${what} link for ${track.title}`}
      title={href}
      className={cn(ICON_LINK, className)}
    >
      <Link2 className="size-4" aria-hidden="true" />
    </a>
  );
}

export function TracksTable({ tracks }: { tracks: readonly TrackDto[] }) {
  const [filter, setFilter] = useState<ClassificationFilter>("all");
  const [sort, setSort] = useState<TrackSort>(DEFAULT_SORT);

  const counts = useMemo(() => countByClassification(tracks), [tracks]);
  const visible = useMemo(
    () => sortTracks(filterTracks(tracks, filter), sort),
    [tracks, filter, sort],
  );
  const onSort = (key: SortKey) => setSort((current) => nextSort(current, key));

  if (tracks.length === 0) {
    return (
      <EmptyState>
        This playlist has no readable tracks. Add tracks to it on SoundCloud, then add the playlist
        again.
      </EmptyState>
    );
  }

  return (
    <div>
      <div role="group" aria-label="Filter by classification" className="mb-3 flex flex-wrap gap-1">
        {CLASSIFICATION_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-control border px-2.5 text-13 transition-colors duration-150 ease-out",
              filter === option
                ? "border-border bg-surface-2 text-text"
                : "border-transparent text-text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {filterLabel(option)}
            <span className="font-mono text-xs text-text-muted tabular-nums">{counts[option]}</span>
          </button>
        ))}
      </div>

      <p className="sr-only" aria-live="polite">
        Showing {visible.length} of {tracks.length} tracks
      </p>

      {visible.length === 0 ? (
        <EmptyState>
          No {filterLabel(filter).toLowerCase()} tracks in this playlist. Pick another filter to see
          the rest.
        </EmptyState>
      ) : (
        <Table aria-label="Tracks">
          <TableHeader>
            <TableRow>
              <SortHead
                label="#"
                sortKey="position"
                sort={sort}
                onSort={onSort}
                className="hidden w-10 md:table-cell"
              />
              <TableHead className="w-11 md:w-10">
                <span className="sr-only">Artwork</span>
              </TableHead>
              <SortHead label="Title" sortKey="title" sort={sort} onSort={onSort} />
              <SortHead
                label="Class"
                sortKey="classification"
                sort={sort}
                onSort={onSort}
                className="hidden w-[5.5rem] md:table-cell"
              />
              <TableHead className="hidden w-36 sm:table-cell xl:w-44">Status</TableHead>
              <SortHead
                label="Gate"
                sortKey="gatePlatform"
                sort={sort}
                onSort={onSort}
                className="hidden w-20 lg:table-cell"
              />
              <SortHead
                label="Time"
                sortKey="duration"
                sort={sort}
                onSort={onSort}
                className="hidden w-14 md:table-cell"
              />
              <TableHead className="hidden w-32 md:table-cell xl:w-56">HQ Download</TableHead>
              <TableHead className="w-[4.5rem] md:w-12">Link</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((track) => (
              <TableRow key={track.id} className="hover:bg-surface-2">
                <TableCell className="hidden font-mono text-xs text-text-muted tabular-nums md:table-cell">
                  {track.position + 1}
                </TableCell>
                <TableCell>
                  <Artwork url={track.artworkUrl} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 leading-4">
                    <span className="truncate text-text" title={track.title}>
                      {track.title}
                    </span>
                    {/* Below 640px the status column folds into this line; a track that
                        has never been run shows its classification there instead. */}
                    <StatusBadge
                      status={trackStatus(track) ?? track.classification}
                      className="ml-auto shrink-0 text-xs sm:hidden"
                    />
                  </div>
                  <div className="truncate text-xs leading-4 text-text-muted" title={track.artist}>
                    {track.artist}
                    {/* The classification, gate and duration columns fold into this line
                        as each of them drops out. */}
                    <span className="md:hidden">{` · ${statusLabel(track.classification)}`}</span>
                    <span className="font-mono tabular-nums">
                      {track.gatePlatform !== null && (
                        <span className="lg:hidden">{` · ${track.gatePlatform}`}</span>
                      )}
                      <span className="md:hidden">{` · ${formatDuration(track.durationMs)}`}</span>
                    </span>
                  </div>
                  <Reason track={track} />
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <StatusBadge status={track.classification} />
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <RunStatus track={track} />
                </TableCell>
                <TableCell className="hidden truncate font-mono text-xs text-text-muted lg:table-cell">
                  {track.gatePlatform ?? <span aria-hidden="true">—</span>}
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-text-muted tabular-nums md:table-cell">
                  {formatDuration(track.durationMs)}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <div className="flex items-center">
                    <HqDownloadLink track={track} />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {/* Below 768px the HQ Download column folds into this cell as an icon. */}
                    <HqDownloadIcon track={track} className="md:hidden" />
                    <a
                      href={safeHref(track.permalinkUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${track.title} on SoundCloud`}
                      title="Open on SoundCloud"
                      className={ICON_LINK}
                    >
                      <ExternalLink className="size-4" aria-hidden="true" />
                    </a>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
