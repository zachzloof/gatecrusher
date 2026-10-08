import {
  playlistSlug,
  type DownloadKind,
  type IngestSource,
  type IngestedTrack,
  type TrackClassification,
} from "@gatecrusher/core";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
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
  /** Its verified downloads: what deleting the playlist removes from disk. */
  downloads: { count: number; bytes: number };
}

function emptyCounts(): ClassificationCounts {
  return { native: 0, gate: 0, buy: 0, none: 0 };
}

/** Every playlist, most recently ingested first, with its tracks counted per classification. */
export async function listPlaylists(db: Database): Promise<PlaylistWithCounts[]> {
  const [rows, grouped, downloaded] = await Promise.all([
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
    db
      .select({
        playlistId: tracks.playlistId,
        count: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${downloads.sizeBytes}), 0)::float8`,
      })
      .from(downloads)
      .innerJoin(tracks, eq(downloads.trackId, tracks.id))
      .groupBy(tracks.playlistId),
  ]);
  const downloadsByPlaylist = new Map(
    downloaded.map((row) => [row.playlistId, { count: row.count, bytes: row.bytes }]),
  );

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
      downloads: downloadsByPlaylist.get(row.id) ?? { count: 0, bytes: 0 },
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

export interface PlaylistDownloadRow {
  trackId: string;
  position: number;
  title: string;
  artist: string;
  /** Relative to the data dir. */
  filePath: string;
  sizeBytes: number;
  kind: DownloadKind;
}

/** A playlist's verified downloads in playlist order, or `null` for an unknown playlist. */
export async function listPlaylistDownloads(
  db: Database,
  playlistId: string,
): Promise<{ playlist: PlaylistRow; files: PlaylistDownloadRow[] } | null> {
  const [playlist] = await db.select().from(playlists).where(eq(playlists.id, playlistId));
  if (playlist === undefined) return null;

  const files = await db
    .select({
      trackId: tracks.id,
      position: tracks.position,
      title: tracks.title,
      artist: tracks.artist,
      filePath: downloads.filePath,
      sizeBytes: downloads.sizeBytes,
      kind: downloads.kind,
    })
    .from(downloads)
    .innerJoin(tracks, eq(downloads.trackId, tracks.id))
    .where(eq(tracks.playlistId, playlistId))
    .orderBy(asc(tracks.position), asc(tracks.id));
  return { playlist, files };
}

export type DeletePlaylistResult =
  | {
      ok: true;
      /** The verified downloads it had, relative to the data dir, for the caller to remove. */
      filePaths: string[];
      /**
       * The playlist's download folder (its slug under `downloads/`) and whether another
       * playlist still saves into the same one, in which case only `filePaths` may go.
       */
      folder: { slug: string; shared: boolean };
    }
  | { ok: false; kind: "playlist_not_found" | "busy"; reason: string };

/**
 * Removes a playlist and everything recorded about it: tracks, runs, jobs, events and
 * download rows all cascade. Refused while one of its tracks is downloading, so the
 * worker never writes a file the database no longer knows about. Queued jobs go with it;
 * the worker skips them when the queue hands them over.
 */
export async function deletePlaylist(
  db: Database,
  playlistId: string,
): Promise<DeletePlaylistResult> {
  return db.transaction(async (tx) => {
    const [playlist] = await tx
      .select({ id: playlists.id, soundcloudUrl: playlists.soundcloudUrl, title: playlists.title })
      .from(playlists)
      .where(eq(playlists.id, playlistId))
      .for("update");
    if (playlist === undefined) {
      return { ok: false, kind: "playlist_not_found", reason: "No such playlist." };
    }

    // Locking the job rows makes the worker's start of a queued job wait for this
    // transaction, and a job it already started shows up as RUNNING here.
    const trackIds = tx
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.playlistId, playlistId));
    const playlistJobs = await tx
      .select({ status: jobs.status })
      .from(jobs)
      .where(inArray(jobs.trackId, trackIds))
      .for("update");
    if (playlistJobs.some((job) => job.status === "RUNNING")) {
      return {
        ok: false,
        kind: "busy",
        reason:
          "A track from this playlist is downloading right now. Open the playlist, click Cancel, wait for that track to finish, then delete it.",
      };
    }

    const files = await tx
      .select({ filePath: downloads.filePath })
      .from(downloads)
      .where(inArray(downloads.trackId, trackIds));
    await tx.delete(playlists).where(eq(playlists.id, playlistId));

    // Two playlists with the same slug (a title reused, say) share one folder on disk.
    const slug = playlistSlug(playlist.soundcloudUrl, playlist.title);
    const others = await tx
      .select({ soundcloudUrl: playlists.soundcloudUrl, title: playlists.title })
      .from(playlists);
    const shared = others.some((other) => playlistSlug(other.soundcloudUrl, other.title) === slug);
    return { ok: true, filePaths: files.map((file) => file.filePath), folder: { slug, shared } };
  });
}
