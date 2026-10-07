"use client";

import { ArrowDown, ArrowUp, ExternalLink, Link2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
        className="hidden w-52 truncate font-mono text-xs text-text-muted underline-offset-2 hover:text-text hover:underline xl:block"
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

const CHECKBOX = "size-4 shrink-0 cursor-pointer accent-text";

/** Narrow columns keep to their text; whatever is left goes to the title. */
const SNUG = "whitespace-nowrap";

/** Checked, unchecked, or part-way: the header box that ticks every visible row. */
function SelectAllBox({
  visible,
  selected,
  onChange,
}: {
  visible: readonly TrackDto[];
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const tickedCount = visible.filter((track) => selected.has(track.id)).length;
  const all = visible.length > 0 && tickedCount === visible.length;
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = tickedCount > 0 && !all;
  }, [tickedCount, all]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all shown tracks"
      className={CHECKBOX}
      checked={all}
      onChange={() => {
        const next = new Set(selected);
        for (const track of visible) {
          if (all) next.delete(track.id);
          else next.add(track.id);
        }
        onChange(next);
      }}
    />
  );
}

interface TracksTableProps {
  tracks: readonly TrackDto[];
  /** Ids of the ticked tracks. */
  selected: ReadonlySet<string>;
  onSelectedChange: (next: ReadonlySet<string>) => void;
}

export function TracksTable({ tracks, selected, onSelectedChange }: TracksTableProps) {
  const [filter, setFilter] = useState<ClassificationFilter>("all");
  const [sort, setSort] = useState<TrackSort>(DEFAULT_SORT);

  const counts = useMemo(() => countByClassification(tracks), [tracks]);
  const visible = useMemo(
    () => sortTracks(filterTracks(tracks, filter), sort),
    [tracks, filter, sort],
  );
  const onSort = (key: SortKey) => setSort((current) => nextSort(current, key));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    onSelectedChange(next);
  };

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
        // Auto layout: each narrow column is as wide as its text, the title gets the rest.
        <Table aria-label="Tracks" className="table-auto">
          <TableHeader>
            <TableRow>
              <SortHead
                label="#"
                sortKey="position"
                sort={sort}
                onSort={onSort}
                className={cn("hidden md:table-cell", SNUG)}
              />
              <TableHead className="w-11 md:w-10">
                <span className="sr-only">Artwork</span>
              </TableHead>
              <SortHead
                label="Title"
                sortKey="title"
                sort={sort}
                onSort={onSort}
                className="w-full"
              />
              <SortHead
                label="Class"
                sortKey="classification"
                sort={sort}
                onSort={onSort}
                className={cn("hidden md:table-cell", SNUG)}
              />
              <TableHead className={cn("hidden sm:table-cell", SNUG)}>Status</TableHead>
              <SortHead
                label="Gate"
                sortKey="gatePlatform"
                sort={sort}
                onSort={onSort}
                className={cn("hidden lg:table-cell", SNUG)}
              />
              <SortHead
                label="Time"
                sortKey="duration"
                sort={sort}
                onSort={onSort}
                className={cn("hidden md:table-cell", SNUG)}
              />
              <TableHead className={cn("hidden lg:table-cell", SNUG)}>HQ Download</TableHead>
              <TableHead className={SNUG}>Link</TableHead>
              <TableHead className={SNUG}>
                <SelectAllBox visible={visible} selected={selected} onChange={onSelectedChange} />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((track) => (
              <TableRow key={track.id} className="hover:bg-surface-2">
                <TableCell
                  className={cn(
                    "hidden font-mono text-xs text-text-muted tabular-nums md:table-cell",
                    SNUG,
                  )}
                >
                  {track.position + 1}
                </TableCell>
                <TableCell>
                  <Artwork url={track.artworkUrl} />
                </TableCell>
                {/* max-w-0 lets the title truncate instead of stretching the table. */}
                <TableCell className="w-full max-w-0">
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
                <TableCell className={cn("hidden md:table-cell", SNUG)}>
                  <StatusBadge status={track.classification} />
                </TableCell>
                <TableCell className={cn("hidden sm:table-cell", SNUG)}>
                  {/* Capped so a long step name truncates instead of widening the column. */}
                  <RunStatus track={track} className="max-w-48" />
                </TableCell>
                <TableCell
                  className={cn("hidden font-mono text-xs text-text-muted lg:table-cell", SNUG)}
                >
                  {track.gatePlatform ?? <span aria-hidden="true">—</span>}
                </TableCell>
                <TableCell
                  className={cn(
                    "hidden font-mono text-xs text-text-muted tabular-nums md:table-cell",
                    SNUG,
                  )}
                >
                  {formatDuration(track.durationMs)}
                </TableCell>
                <TableCell className={cn("hidden lg:table-cell", SNUG)}>
                  <div className="flex items-center">
                    <HqDownloadLink track={track} />
                  </div>
                </TableCell>
                <TableCell className={SNUG}>
                  <div className="flex items-center gap-1">
                    {/* Below 1024px the HQ Download column folds into this cell as an icon. */}
                    <HqDownloadIcon track={track} className="lg:hidden" />
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
                <TableCell className={SNUG}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${track.title}`}
                    className={CHECKBOX}
                    checked={selected.has(track.id)}
                    onChange={() => toggle(track.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
