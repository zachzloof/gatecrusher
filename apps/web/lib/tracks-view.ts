// Sorting, filtering and counting for the tracks table. Pure, so it is unit-tested
// without rendering anything.
import { TRACK_CLASSIFICATIONS, type TrackClassification } from "@gatecrusher/core";
import type { TrackDto } from "./api-schemas";

export const SORT_KEYS = [
  "position",
  "title",
  "classification",
  "gatePlatform",
  "duration",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export interface TrackSort {
  key: SortKey;
  direction: SortDirection;
}

export const DEFAULT_SORT: TrackSort = { key: "position", direction: "asc" };

export type ClassificationFilter = TrackClassification | "all";

const CLASSIFICATION_ORDER: Record<TrackClassification, number> = {
  native: 0,
  gate: 1,
  buy: 2,
  none: 3,
};

/** Clicking the active column flips its direction; a new column starts ascending. */
export function nextSort(current: TrackSort, key: SortKey): TrackSort {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Negative, zero or positive; `null` means "no value", which always sorts last. */
function compareBy(key: SortKey, a: TrackDto, b: TrackDto): number | null {
  switch (key) {
    case "position":
      return a.position - b.position;
    case "title":
      return collator.compare(a.title, b.title) || collator.compare(a.artist, b.artist);
    case "classification":
      return CLASSIFICATION_ORDER[a.classification] - CLASSIFICATION_ORDER[b.classification];
    case "gatePlatform":
      if (a.gatePlatform === null || b.gatePlatform === null) return null;
      return collator.compare(a.gatePlatform, b.gatePlatform);
    case "duration":
      if (a.durationMs === null || b.durationMs === null) return null;
      return a.durationMs - b.durationMs;
  }
}

function isMissing(key: SortKey, track: TrackDto): boolean {
  if (key === "gatePlatform") return track.gatePlatform === null;
  if (key === "duration") return track.durationMs === null;
  return false;
}

/** A sorted copy. Ties keep playlist order; tracks without a value go last either way. */
export function sortTracks(tracks: readonly TrackDto[], sort: TrackSort): TrackDto[] {
  const flip = sort.direction === "asc" ? 1 : -1;
  return [...tracks].sort((a, b) => {
    const missingA = isMissing(sort.key, a);
    const missingB = isMissing(sort.key, b);
    if (missingA !== missingB) return missingA ? 1 : -1;
    const compared = compareBy(sort.key, a, b) ?? 0;
    return compared !== 0 ? compared * flip : a.position - b.position;
  });
}

export function filterTracks(
  tracks: readonly TrackDto[],
  filter: ClassificationFilter,
): TrackDto[] {
  return filter === "all" ? [...tracks] : tracks.filter((track) => track.classification === filter);
}

export function countByClassification(
  tracks: readonly TrackDto[],
): Record<ClassificationFilter, number> {
  const counts: Record<ClassificationFilter, number> = {
    all: tracks.length,
    native: 0,
    gate: 0,
    buy: 0,
    none: 0,
  };
  for (const track of tracks) counts[track.classification] += 1;
  return counts;
}

export const CLASSIFICATION_FILTERS: readonly ClassificationFilter[] = [
  "all",
  ...TRACK_CLASSIFICATIONS,
];
