// The logic behind the playlist and buy-list routes, with everything they touch passed
// in, so tests can run them against a throwaway database and fake sources.
import { canonicalPlaylistUrl, storeNameForUrl } from "@gatecrusher/core";
import {
  getPlaylistTrackStates,
  getPlaylistWithTracks,
  listBuyTracks,
  listPlaylists,
  type Database,
  type PlaylistRow,
  type TrackRunState,
} from "@gatecrusher/db";
import { z } from "zod";
import {
  addPlaylistRequestSchema,
  addPlaylistResponseSchema,
  buyListResponseSchema,
  listPlaylistsResponseSchema,
  playlistDetailResponseSchema,
  type PlaylistDto,
  type TrackDto,
} from "./api-schemas";
import {
  errorResponse,
  guarded,
  NO_STORE,
  READ_TIMEOUT_MS,
  type HandlerLog,
} from "./handler-utils";
import type { IngestResult } from "./ingest";
import { screenshotUrl } from "./screenshots";
import { withTimeout } from "./with-timeout";

export type { HandlerLog };

export interface HandlerDeps {
  db: Database;
  /** Takes a canonical playlist URL. */
  ingest(playlistUrl: string): Promise<IngestResult>;
  log: HandlerLog;
}

function toPlaylistDto(row: PlaylistRow): PlaylistDto {
  return {
    id: row.id,
    title: row.title,
    owner: row.owner,
    soundcloudUrl: row.soundcloudUrl,
    artworkUrl: row.artworkUrl,
    ingestSource: row.ingestSource,
    lastIngestedAt: row.lastIngestedAt?.toISOString() ?? null,
  };
}

/** The track's run state as the UI shows it. File paths never leave the server. */
function toRunStateDto(state: TrackRunState | undefined): Pick<TrackDto, "job" | "download"> {
  if (state === undefined) return { job: null, download: null };
  const { job, humanRequest, download } = state;
  return {
    job:
      job === null
        ? null
        : {
            status: job.status,
            stepName: job.stepName,
            needsHuman:
              humanRequest === null
                ? null
                : {
                    reason: humanRequest.reason,
                    description: humanRequest.description,
                    screenshotUrl: screenshotUrl(humanRequest.screenshotPath),
                  },
            manual:
              job.manualReason === null
                ? null
                : { reason: job.manualReason, detail: job.manualDetail },
            error: job.error,
          },
    download:
      download === null
        ? null
        : {
            fileName: download.filePath.split("/").at(-1) ?? download.filePath,
            sizeBytes: download.sizeBytes,
            kind: download.kind,
          },
  };
}

const INGEST_FAILURES = {
  not_found: { status: 404, code: "playlist_not_found" },
  not_a_playlist: { status: 422, code: "not_a_playlist" },
  upstream_failed: { status: 502, code: "upstream_failed" },
} as const;

/** POST /api/playlists — ingest (or re-ingest) a playlist. */
export function handleAddPlaylist(request: Request, deps: HandlerDeps): Promise<Response> {
  return guarded(deps.log, "POST /api/playlists", async () => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // A body that is not JSON is the client's mistake, answered as such.
      return errorResponse(400, "invalid_json", "Request body must be JSON.");
    }

    const parsed = addPlaylistRequestSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request.";
      return errorResponse(400, "invalid_request", message);
    }

    const result = await deps.ingest(canonicalPlaylistUrl(parsed.data.url));
    if (!result.ok) {
      const { status, code } = INGEST_FAILURES[result.kind];
      if (result.kind === "upstream_failed") {
        return errorResponse(
          status,
          code,
          "Could not read the playlist from SoundCloud right now. Try again in a minute.",
          result.reason,
        );
      }
      return errorResponse(status, code, result.reason);
    }

    return Response.json(
      addPlaylistResponseSchema.parse({
        playlistId: result.playlistId,
        title: result.title,
        source: result.source,
        trackCount: result.trackCount,
        unavailableCount: result.unavailableCount,
      }),
      { status: 201, headers: NO_STORE },
    );
  });
}

/** GET /api/playlists */
export function handleListPlaylists(deps: HandlerDeps): Promise<Response> {
  return guarded(deps.log, "GET /api/playlists", async () => {
    const rows = await withTimeout(listPlaylists(deps.db), READ_TIMEOUT_MS);
    return Response.json(
      listPlaylistsResponseSchema.parse({
        playlists: rows.map((row) => ({
          ...toPlaylistDto(row),
          trackCount: row.trackCount,
          counts: row.counts,
        })),
      }),
      { headers: NO_STORE },
    );
  });
}

/** GET /api/playlists/:id */
export function handleGetPlaylist(playlistId: string, deps: HandlerDeps): Promise<Response> {
  return guarded(deps.log, "GET /api/playlists/:id", async () => {
    const id = z.uuid().safeParse(playlistId);
    const playlist = id.success
      ? await withTimeout(getPlaylistWithTracks(deps.db, id.data), READ_TIMEOUT_MS)
      : null;
    if (playlist === null) return errorResponse(404, "not_found", "No such playlist.");
    const states = await withTimeout(getPlaylistTrackStates(deps.db, playlist.id), READ_TIMEOUT_MS);

    return Response.json(
      playlistDetailResponseSchema.parse({
        playlist: toPlaylistDto(playlist),
        tracks: playlist.tracks.map((track) => ({
          id: track.id,
          position: track.position,
          title: track.title,
          artist: track.artist,
          permalinkUrl: track.permalinkUrl,
          artworkUrl: track.artworkUrl,
          durationMs: track.durationMs,
          classification: track.classification,
          gatePlatform: track.gatePlatform,
          purchaseUrl: track.purchaseUrl,
          purchaseTitle: track.purchaseTitle,
          ...toRunStateDto(states.get(track.id)),
        })),
      }),
      { headers: NO_STORE },
    );
  });
}

/** GET /api/buy-list */
export function handleBuyList(deps: HandlerDeps): Promise<Response> {
  return guarded(deps.log, "GET /api/buy-list", async () => {
    const rows = await withTimeout(listBuyTracks(deps.db), READ_TIMEOUT_MS);
    return Response.json(
      buyListResponseSchema.parse({
        items: rows.flatMap((row) => {
          const store = storeNameForUrl(row.purchaseUrl);
          // A buy track always has a link; a row without one cannot be bought from.
          if (store === null || row.purchaseUrl === null) return [];
          return [
            {
              trackId: row.trackId,
              store,
              title: row.title,
              artist: row.artist,
              purchaseUrl: row.purchaseUrl,
              permalinkUrl: row.permalinkUrl,
              playlistId: row.playlistId,
              playlistTitle: row.playlistTitle,
            },
          ];
        }),
      }),
      { headers: NO_STORE },
    );
  });
}
