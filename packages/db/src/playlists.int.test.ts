import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./client.ts";
import {
  getPlaylistWithTracks,
  listBuyTracks,
  listPlaylists,
  savePlaylistIngest,
  type ClassifiedTrack,
  type SavePlaylistInput,
} from "./playlists.ts";
import { downloads, jobs, playlists, runs, tracks } from "./schema.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.handle.db;
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  // Cascades to tracks, runs, jobs, events, downloads and human requests.
  await db.delete(playlists);
});

function track(id: string, overrides: Partial<ClassifiedTrack> = {}): ClassifiedTrack {
  return {
    soundcloudId: id,
    title: `Track ${id}`,
    artist: "Fixture Artist",
    permalinkUrl: `https://soundcloud.com/fixture-artist/track-${id}`,
    artworkUrl: null,
    durationMs: 300_000,
    purchaseUrl: null,
    purchaseTitle: null,
    downloadable: false,
    classification: "none",
    gatePlatform: null,
    ...overrides,
  };
}

function ingest(overrides: Partial<SavePlaylistInput> = {}): SavePlaylistInput {
  return {
    soundcloudUrl: "https://soundcloud.com/fixture-artist/sets/fixture-crate",
    source: "api_v2",
    soundcloudId: "9001",
    title: "Fixture crate",
    owner: "fixture-artist",
    artworkUrl: null,
    tracks: [track("1"), track("2"), track("3")],
    ...overrides,
  };
}

async function addDownload(trackId: string): Promise<void> {
  await db.insert(downloads).values({
    trackId,
    filePath: "downloads/fixture/file.mp3",
    sizeBytes: 2_000_000,
    mimeType: "audio/mpeg",
    kind: "audio",
    checksumSha256: "a".repeat(64),
    verifiedAt: new Date(),
  });
}

async function trackIdFor(playlistId: string, soundcloudId: string): Promise<string> {
  const playlist = await getPlaylistWithTracks(db, playlistId);
  const found = playlist?.tracks.find((row) => row.soundcloudId === soundcloudId);
  if (found === undefined) throw new Error(`fixture track ${soundcloudId} missing`);
  return found.id;
}

describe("savePlaylistIngest", () => {
  it("stores a playlist and its tracks in order", async () => {
    const result = await savePlaylistIngest(db, ingest());

    expect(result).toMatchObject({ trackCount: 3, removedCount: 0 });
    const playlist = await getPlaylistWithTracks(db, result.playlistId);
    expect(playlist).toMatchObject({
      title: "Fixture crate",
      owner: "fixture-artist",
      ingestSource: "api_v2",
    });
    expect(playlist?.lastIngestedAt).toBeInstanceOf(Date);
    expect(playlist?.tracks.map((row) => [row.position, row.soundcloudId])).toEqual([
      [0, "1"],
      [1, "2"],
      [2, "3"],
    ]);
  });

  it("updates rather than duplicates on re-ingest, keeping row ids", async () => {
    const first = await savePlaylistIngest(db, ingest());
    const before = await getPlaylistWithTracks(db, first.playlistId);

    const second = await savePlaylistIngest(
      db,
      ingest({
        title: "Fixture crate (renamed)",
        source: "yt_dlp",
        tracks: [
          track("3"),
          track("1", {
            title: "Track 1 (retitled)",
            classification: "gate",
            gatePlatform: "hypeddit",
            purchaseUrl: "https://hypeddit.com/track/fixture",
          }),
          track("2"),
        ],
      }),
    );

    expect(second.playlistId).toBe(first.playlistId);
    expect(await db.$count(playlists)).toBe(1);
    expect(await db.$count(tracks)).toBe(3);

    const after = await getPlaylistWithTracks(db, first.playlistId);
    expect(after).toMatchObject({ title: "Fixture crate (renamed)", ingestSource: "yt_dlp" });
    expect(after?.tracks.map((row) => row.soundcloudId)).toEqual(["3", "1", "2"]);
    expect(after?.tracks[1]).toMatchObject({
      title: "Track 1 (retitled)",
      classification: "gate",
      gatePlatform: "hypeddit",
    });

    const idsBefore = new Map(before?.tracks.map((row) => [row.soundcloudId, row.id]));
    for (const row of after?.tracks ?? []) expect(row.id).toBe(idsBefore.get(row.soundcloudId));
  });

  it("keeps existing downloads across a re-ingest", async () => {
    const { playlistId } = await savePlaylistIngest(db, ingest());
    const trackId = await trackIdFor(playlistId, "2");
    await addDownload(trackId);

    await savePlaylistIngest(
      db,
      ingest({ tracks: [track("2", { title: "Renamed" }), track("1")] }),
    );

    const kept = await db.select().from(downloads).where(eq(downloads.trackId, trackId));
    expect(kept).toHaveLength(1);
  });

  it("removes tracks that left the playlist", async () => {
    const { playlistId } = await savePlaylistIngest(db, ingest());

    const result = await savePlaylistIngest(db, ingest({ tracks: [track("1"), track("3")] }));

    expect(result.removedCount).toBe(1);
    const playlist = await getPlaylistWithTracks(db, playlistId);
    expect(playlist?.tracks.map((row) => row.soundcloudId)).toEqual(["1", "3"]);
  });

  it("keeps a track that left the playlist when it has a download or a job, after the rest", async () => {
    const { playlistId } = await savePlaylistIngest(db, ingest());
    const downloadedId = await trackIdFor(playlistId, "1");
    const jobTrackId = await trackIdFor(playlistId, "2");
    await addDownload(downloadedId);
    const [run] = await db.insert(runs).values({ playlistId }).returning({ id: runs.id });
    if (run === undefined) throw new Error("run insert returned no row");
    await db.insert(jobs).values({ runId: run.id, trackId: jobTrackId });

    const result = await savePlaylistIngest(db, ingest({ tracks: [track("4"), track("5")] }));

    expect(result.removedCount).toBe(1);
    const playlist = await getPlaylistWithTracks(db, playlistId);
    expect(playlist?.tracks.map((row) => [row.position, row.soundcloudId])).toEqual([
      [0, "4"],
      [1, "5"],
      [2, "1"],
      [3, "2"],
    ]);
    expect(await db.$count(downloads)).toBe(1);
    expect(await db.$count(jobs)).toBe(1);
  });

  it("handles an empty playlist, removing what was there", async () => {
    const { playlistId } = await savePlaylistIngest(db, ingest());

    const result = await savePlaylistIngest(db, ingest({ tracks: [] }));

    expect(result).toMatchObject({ trackCount: 0, removedCount: 3 });
    expect((await getPlaylistWithTracks(db, playlistId))?.tracks).toEqual([]);
  });

  it("stores more tracks than fit in one insert statement", async () => {
    const many = Array.from({ length: 1_201 }, (_, index) => track(String(index + 1)));

    const { playlistId } = await savePlaylistIngest(db, ingest({ tracks: many }));

    const playlist = await getPlaylistWithTracks(db, playlistId);
    expect(playlist?.tracks).toHaveLength(1_201);
    expect(playlist?.tracks.at(-1)).toMatchObject({ position: 1_200, soundcloudId: "1201" });
  });

  it("does not touch another playlist's tracks", async () => {
    const other = await savePlaylistIngest(
      db,
      ingest({ soundcloudUrl: "https://soundcloud.com/fixture-artist/sets/other", title: "Other" }),
    );
    await savePlaylistIngest(db, ingest({ tracks: [track("9")] }));

    expect((await getPlaylistWithTracks(db, other.playlistId))?.tracks).toHaveLength(3);
  });
});

describe("listPlaylists", () => {
  it("is empty when nothing has been ingested", async () => {
    expect(await listPlaylists(db)).toEqual([]);
  });

  it("counts tracks per classification", async () => {
    await savePlaylistIngest(
      db,
      ingest({
        tracks: [
          track("1", { classification: "native", downloadable: true }),
          track("2", { classification: "gate", gatePlatform: "hypeddit" }),
          track("3", { classification: "gate", gatePlatform: "unknown" }),
          track("4", { classification: "buy" }),
          track("5"),
        ],
      }),
    );
    await savePlaylistIngest(
      db,
      ingest({ soundcloudUrl: "https://soundcloud.com/fixture-artist/sets/empty", tracks: [] }),
    );

    const listed = await listPlaylists(db);

    expect(listed).toHaveLength(2);
    const full = listed.find((row) => row.trackCount > 0);
    expect(full).toMatchObject({ trackCount: 5, counts: { native: 1, gate: 2, buy: 1, none: 1 } });
    const empty = listed.find((row) => row.trackCount === 0);
    expect(empty?.counts).toEqual({ native: 0, gate: 0, buy: 0, none: 0 });
  });
});

describe("getPlaylistWithTracks", () => {
  it("returns null for an unknown id", async () => {
    expect(await getPlaylistWithTracks(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("listBuyTracks", () => {
  it("returns only buy tracks, with their playlist", async () => {
    const { playlistId } = await savePlaylistIngest(
      db,
      ingest({
        tracks: [
          track("1", { classification: "gate", gatePlatform: "hypeddit" }),
          track("2", {
            classification: "buy",
            purchaseUrl: "https://fixture-label.bandcamp.com/track/two",
            purchaseTitle: "Buy",
          }),
          track("3", { classification: "buy", purchaseUrl: "https://www.beatport.com/track/x/1" }),
        ],
      }),
    );

    const rows = await listBuyTracks(db);

    expect(rows.map((row) => row.title)).toEqual(["Track 2", "Track 3"]);
    expect(rows[0]).toMatchObject({
      artist: "Fixture Artist",
      purchaseUrl: "https://fixture-label.bandcamp.com/track/two",
      purchaseTitle: "Buy",
      playlistId,
      playlistTitle: "Fixture crate",
    });
  });
});
