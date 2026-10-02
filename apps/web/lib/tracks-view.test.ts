import { describe, expect, it } from "vitest";
import type { TrackDto } from "./api-schemas";
import {
  countByClassification,
  DEFAULT_SORT,
  filterTracks,
  nextSort,
  sortTracks,
} from "./tracks-view";

function track(position: number, overrides: Partial<TrackDto> = {}): TrackDto {
  return {
    id: `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
    position,
    title: `Track ${position}`,
    artist: "Artist",
    permalinkUrl: `https://soundcloud.com/a/track-${position}`,
    artworkUrl: null,
    durationMs: 200_000,
    classification: "none",
    gatePlatform: null,
    purchaseUrl: null,
    purchaseTitle: null,
    job: null,
    download: null,
    ...overrides,
  };
}

const TRACKS: readonly TrackDto[] = [
  track(0, { title: "delta", classification: "buy", durationMs: 300_000 }),
  track(1, { title: "Alpha", classification: "gate", gatePlatform: "toneden", durationMs: null }),
  track(2, { title: "charlie", classification: "native", durationMs: 100_000 }),
  track(3, { title: "Bravo 10", classification: "gate", gatePlatform: "hypeddit" }),
  track(4, { title: "Bravo 2", classification: "none", durationMs: 100_000 }),
];

const positions = (tracks: readonly TrackDto[]) => tracks.map((item) => item.position);

describe("sortTracks", () => {
  it("defaults to playlist order", () => {
    expect(positions(sortTracks([...TRACKS].reverse(), DEFAULT_SORT))).toEqual([0, 1, 2, 3, 4]);
  });

  it("sorts titles case-insensitively and numbers naturally", () => {
    expect(positions(sortTracks(TRACKS, { key: "title", direction: "asc" }))).toEqual([
      1, 4, 3, 2, 0,
    ]);
    expect(positions(sortTracks(TRACKS, { key: "title", direction: "desc" }))).toEqual([
      0, 2, 3, 4, 1,
    ]);
  });

  it("sorts by classification in native, gate, buy, none order, ties in playlist order", () => {
    expect(positions(sortTracks(TRACKS, { key: "classification", direction: "asc" }))).toEqual([
      2, 1, 3, 0, 4,
    ]);
  });

  it("sorts by duration with unknown durations last in both directions", () => {
    expect(positions(sortTracks(TRACKS, { key: "duration", direction: "asc" }))).toEqual([
      2, 4, 3, 0, 1,
    ]);
    expect(positions(sortTracks(TRACKS, { key: "duration", direction: "desc" }))).toEqual([
      0, 3, 2, 4, 1,
    ]);
  });

  it("sorts by gate platform with tracks that have none last", () => {
    expect(positions(sortTracks(TRACKS, { key: "gatePlatform", direction: "asc" }))).toEqual([
      3, 1, 0, 2, 4,
    ]);
    expect(
      positions(sortTracks(TRACKS, { key: "gatePlatform", direction: "desc" })).slice(0, 2),
    ).toEqual([1, 3]);
  });

  it("does not mutate its input", () => {
    const input = [...TRACKS];
    sortTracks(input, { key: "title", direction: "asc" });
    expect(input).toEqual(TRACKS);
  });
});

describe("nextSort", () => {
  it("starts a new column ascending and flips the active one", () => {
    expect(nextSort(DEFAULT_SORT, "title")).toEqual({ key: "title", direction: "asc" });
    expect(nextSort({ key: "title", direction: "asc" }, "title")).toEqual({
      key: "title",
      direction: "desc",
    });
    expect(nextSort({ key: "title", direction: "desc" }, "title")).toEqual({
      key: "title",
      direction: "asc",
    });
  });
});

describe("filterTracks and countByClassification", () => {
  it("filters by classification", () => {
    expect(positions(filterTracks(TRACKS, "gate"))).toEqual([1, 3]);
    expect(positions(filterTracks(TRACKS, "all"))).toEqual([0, 1, 2, 3, 4]);
  });

  it("counts every classification, including empty ones", () => {
    expect(countByClassification(TRACKS)).toEqual({ all: 5, native: 1, gate: 2, buy: 1, none: 1 });
    expect(countByClassification([])).toEqual({ all: 0, native: 0, gate: 0, buy: 0, none: 0 });
  });
});
