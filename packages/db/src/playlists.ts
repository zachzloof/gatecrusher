import type { IngestSource, IngestedTrack, TrackClassification } from "@gatecrusher/core";
import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { downloads, jobs, playlists, tracks } from "./schema.ts";

export type PlaylistRow = typeof playlists.$inferSelect;
export type TrackRow = typeof tracks.$inferSelect;

export interface ClassifiedTrack extends IngestedTrack {
  classification: TrackClassification;
  gatePlatform: string | null;
}

export interface SavePlaylistInput {
  /** Canonical playlist URL; the key a re-ingest matches on. */
  soundcloudUrl: string;
  source: IngestSource;
  soundcloudId: string | null;
  title: string;
  owner: string | null;
  artworkUrl: string | null;
  /** In playlist order, unique by `soundcloudId`. */
  tracks: readonly ClassifiedTrack[];
}

export interface SavePlaylistResult {
  playlistId: string;
  trackCount: number;
  /** Tracks deleted because they left the playlist. */
  removedCount: number;
}

/** Well under Postgres' 65535 bind parameters per statement. */
const INSERT_CHUNK_SIZE = 500;

/**
 * Stores an ingest. Idempotent: the playlist is matched on its URL and tracks on their
 * SoundCloud id, so a re-ingest updates rows in place and their downloads and jobs stay
 * attached. A track that has left the playlist is deleted, unless it has a download or
 * job history, in which case it is kept and moved to the end.
 */
export async function savePlaylistIngest(
  db: Database,
  input: SavePlaylistInput,
): Promise<SavePlaylistResult> {
  return db.transaction(async (tx) => {
    const details = {
      soundcloudId: input.soundcloudId,
      title: input.title,
      owner: input.owner,
      artworkUrl: input.artworkUrl,
      ingestSource: input.source,
      lastIngestedAt: sql`now()`,
    };
    const [playlist] = await tx
      .insert(playlists)
      .values({ soundcloudUrl: input.soundcloudUrl, ...details })
      .onConflictDoUpdate({
        target: playlists.soundcloudUrl,
        set: { ...details, updatedAt: sql`now()` },
      })
      .returning({ id: playlists.id });
    if (playlist === undefined) throw new Error("Playlist upsert returned no row");

    for (let start = 0; start < input.tracks.length; start += INSERT_CHUNK_SIZE) {
      const chunk = input.tracks.slice(start, start + INSERT_CHUNK_SIZE);
      await tx
        .insert(tracks)
        .values(
          chunk.map((track, index) => ({
            playlistId: playlist.id,
            position: start + index,
            soundcloudId: track.soundcloudId,
            title: track.title,
            artist: track.artist,
            permalinkUrl: track.permalinkUrl,
            artworkUrl: track.artworkUrl,
            durationMs: track.durationMs,
            purchaseUrl: track.purchaseUrl,
            purchaseTitle: track.purchaseTitle,
            downloadable: track.downloadable,
            classification: track.classification,
            gatePlatform: track.gatePlatform,
          })),
        )
        .onConflictDoUpdate({
          target: [tracks.playlistId, tracks.soundcloudId],
          set: {
            position: sql`excluded.position`,
            title: sql`excluded.title`,
            artist: sql`excluded.artist`,
            permalinkUrl: sql`excluded.permalink_url`,
            artworkUrl: sql`excluded.artwork_url`,
            durationMs: sql`excluded.duration_ms`,
            purchaseUrl: sql`excluded.purchase_url`,
            purchaseTitle: sql`excluded.purchase_title`,
            downloadable: sql`excluded.downloadable`,
            classification: sql`excluded.classification`,
            gatePlatform: sql`excluded.gate_platform`,
            updatedAt: sql`now()`,
          },
        });
    }

    const currentIds = input.tracks.map((track) => track.soundcloudId);
    const leftPlaylist = and(
      eq(tracks.playlistId, playlist.id),
      currentIds.length > 0 ? notInArray(tracks.soundcloudId, currentIds) : undefined,
    );

    // Raw `exists` so the outer `tracks.id` is rendered table-qualified in the subquery.
    const removed = await tx
      .delete(tracks)
      .where(
        and(
          leftPlaylist,
          sql`not exists (select 1 from ${downloads} where ${downloads.trackId} = ${tracks.id})`,
          sql`not exists (select 1 from ${jobs} where ${jobs.trackId} = ${tracks.id})`,
        ),
      )
      .returning({ id: tracks.id });

    // Whatever is left has history worth keeping: park it after the current tracks.
    const kept = await tx
      .select({ id: tracks.id })
      .from(tracks)
      .where(leftPlaylist)
      .orderBy(asc(tracks.position), asc(tracks.id));
    for (const [index, track] of kept.entries()) {
      await tx
        .update(tracks)
        .set({ position: input.tracks.length + index })
        .where(eq(tracks.id, track.id));
    }

    return {
      playlistId: playlist.id,
      trackCount: input.tracks.length,
      removedCount: removed.length,
    };
  });
}

export type ClassificationCounts = Record<TrackClassification, number>;

export interface PlaylistWithCounts extends PlaylistRow {
  trackCount: number;
  counts: ClassificationCounts;
}

function emptyCounts(): ClassificationCounts {
  return { native: 0, gate: 0, buy: 0, none: 0 };
}

/** Every playlist, most recently ingested first, with its tracks counted per classification. */
export async function listPlaylists(db: Database): Promise<PlaylistWithCounts[]> {
  const [rows, grouped] = await Promise.all([
    db
      .select()
      .from(playlists)
      .orderBy(sql`${playlists.lastIngestedAt} desc nulls last`, desc(playlists.createdAt)),
    db
      .select({
        playlistId: tracks.playlistId,
        classification: tracks.classification,
        count: sql<number>`count(*)::int`,
      })
      .from(tracks)
      .groupBy(tracks.playlistId, tracks.classification),
  ]);

  const countsByPlaylist = new Map<string, ClassificationCounts>();
  for (const group of grouped) {
    const counts = countsByPlaylist.get(group.playlistId) ?? emptyCounts();
    counts[group.classification] = group.count;
    countsByPlaylist.set(group.playlistId, counts);
  }

  return rows.map((row) => {
    const counts = countsByPlaylist.get(row.id) ?? emptyCounts();
    return {
      ...row,
      counts,
      trackCount: counts.native + counts.gate + counts.buy + counts.none,
    };
  });
}

export interface PlaylistWithTracks extends PlaylistRow {
  tracks: TrackRow[];
}

/** One playlist with its tracks in playlist order, or `null` when there is no such playlist. */
export async function getPlaylistWithTracks(
  db: Database,
  playlistId: string,
): Promise<PlaylistWithTracks | null> {
  const [playlist] = await db.select().from(playlists).where(eq(playlists.id, playlistId));
  if (playlist === undefined) return null;

  const rows = await db
    .select()
    .from(tracks)
    .where(eq(tracks.playlistId, playlistId))
    .orderBy(asc(tracks.position), asc(tracks.id));
  return { ...playlist, tracks: rows };
}

export interface BuyTrackRow {
  trackId: string;
  title: string;
  artist: string;
  permalinkUrl: string;
  purchaseUrl: string | null;
  purchaseTitle: string | null;
  playlistId: string;
  playlistTitle: string;
}

/** Every `buy` track across all playlists, grouped by playlist in playlist order. */
export async function listBuyTracks(db: Database): Promise<BuyTrackRow[]> {
  return db
    .select({
      trackId: tracks.id,
      title: tracks.title,
      artist: tracks.artist,
      permalinkUrl: tracks.permalinkUrl,
      purchaseUrl: tracks.purchaseUrl,
      purchaseTitle: tracks.purchaseTitle,
      playlistId: playlists.id,
      playlistTitle: playlists.title,
    })
    .from(tracks)
    .innerJoin(playlists, eq(tracks.playlistId, playlists.id))
    .where(eq(tracks.classification, "buy"))
    .orderBy(asc(playlists.title), asc(playlists.id), asc(tracks.position), asc(tracks.id));
}
