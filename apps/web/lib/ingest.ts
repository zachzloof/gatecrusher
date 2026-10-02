import { classifyTrack, type IngestSource, type IngestedPlaylist } from "@gatecrusher/core";
import { savePlaylistIngest, type Database } from "@gatecrusher/db";
import type { PlaylistSource } from "./soundcloud/types";
import { withTimeout } from "./with-timeout";

/** Saving is one transaction; this only bites when Postgres is not answering. */
const SAVE_TIMEOUT_MS = 30_000;

export interface IngestLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface IngestDeps {
  db: Database;
  /** Primary source. */
  apiV2: PlaylistSource;
  /** Used only when the primary source itself is unavailable. */
  ytDlp: PlaylistSource;
  log: IngestLog;
}

export type IngestResult =
  | {
      ok: true;
      playlistId: string;
      title: string;
      source: IngestSource;
      trackCount: number;
      /** Tracks the playlist lists that could not be read (private, removed, geo-blocked). */
      unavailableCount: number;
    }
  | { ok: false; kind: "not_found" | "not_a_playlist" | "upstream_failed"; reason: string };

async function store(
  db: Database,
  playlistUrl: string,
  playlist: IngestedPlaylist,
): Promise<IngestResult> {
  const input = {
    soundcloudUrl: playlistUrl,
    source: playlist.source,
    soundcloudId: playlist.soundcloudId,
    title: playlist.title,
    owner: playlist.owner,
    artworkUrl: playlist.artworkUrl,
    tracks: playlist.tracks.map((track) => {
      const { classification, gatePlatform } = classifyTrack(track);
      return { ...track, classification, gatePlatform };
    }),
  };
  const saved = await withTimeout(savePlaylistIngest(db, input), SAVE_TIMEOUT_MS);
  return {
    ok: true,
    playlistId: saved.playlistId,
    title: playlist.title,
    source: playlist.source,
    trackCount: saved.trackCount,
    unavailableCount: playlist.unavailableCount,
  };
}

/**
 * Resolves a playlist, classifies its tracks and stores them. api-v2 first; yt-dlp only
 * when api-v2 could not be used at all — a definite "not found" or "not a playlist" is
 * the answer and is not retried elsewhere.
 *
 * `playlistUrl` must be the canonical URL. Expected outcomes are results; only a
 * database failure rejects.
 */
export async function ingestPlaylist(deps: IngestDeps, playlistUrl: string): Promise<IngestResult> {
  const primary = await deps.apiV2(playlistUrl);
  if (primary.ok) return store(deps.db, playlistUrl, primary.playlist);
  if (primary.kind !== "unavailable") {
    return { ok: false, kind: primary.kind, reason: primary.reason };
  }

  deps.log.warn({ reason: primary.reason }, "api-v2 ingest failed, falling back to yt-dlp");
  const fallback = await deps.ytDlp(playlistUrl);
  if (fallback.ok) return store(deps.db, playlistUrl, fallback.playlist);
  if (fallback.kind !== "unavailable") {
    return { ok: false, kind: fallback.kind, reason: fallback.reason };
  }

  deps.log.warn({ reason: fallback.reason }, "yt-dlp ingest failed");
  return {
    ok: false,
    kind: "upstream_failed",
    reason: `${primary.reason}. ${fallback.reason}.`,
  };
}
