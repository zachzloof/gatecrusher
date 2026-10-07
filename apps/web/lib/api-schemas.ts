// Request and response shapes for the API route handlers. Shared with client
// components, so this file must stay free of server-only imports.
import {
  downloadKindSchema,
  humanReasonSchema,
  ingestSourceSchema,
  jobStatusSchema,
  manualReasonSchema,
  soundcloudPlaylistUrlSchema,
  soundcloudTokenSchema,
  trackClassificationSchema,
} from "@gatecrusher/core";
import { z } from "zod";

export const API_ERROR_CODES = [
  "invalid_json",
  "invalid_request",
  /** SoundCloud has no public playlist at the URL (missing, deleted or private). */
  "playlist_not_found",
  /** The URL resolves to something else (a track, a user). */
  "not_a_playlist",
  /** Neither api-v2 nor yt-dlp could be used. */
  "upstream_failed",
  /** No such row in Gatecrusher's own database. */
  "not_found",
  /** Downloads need a signed-in SoundCloud account and none is connected. */
  "soundcloud_not_connected",
  /** SoundCloud refused the pasted login token. */
  "soundcloud_token_rejected",
  /** One of the playlist's tracks is downloading, so it cannot be deleted yet. */
  "playlist_busy",
  "internal",
] as const;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    /** Technical detail for the collapsed section of an error state. */
    detail: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError["error"]["code"];

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.object({ ok: z.boolean() }),
  worker: z.object({
    online: z.boolean(),
    lastBeatAt: z.iso.datetime().nullable(),
  }),
  checkedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const addPlaylistRequestSchema = z.object({
  url: soundcloudPlaylistUrlSchema,
});
export type AddPlaylistRequest = z.infer<typeof addPlaylistRequestSchema>;

export const addPlaylistResponseSchema = z.object({
  playlistId: z.uuid(),
  title: z.string(),
  source: ingestSourceSchema,
  trackCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
});
export type AddPlaylistResponse = z.infer<typeof addPlaylistResponseSchema>;

const playlistSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  owner: z.string().nullable(),
  soundcloudUrl: z.string(),
  artworkUrl: z.string().nullable(),
  ingestSource: ingestSourceSchema.nullable(),
  lastIngestedAt: z.iso.datetime().nullable(),
});
export type PlaylistDto = z.infer<typeof playlistSchema>;

const playlistSummarySchema = playlistSchema.extend({
  trackCount: z.number().int().nonnegative(),
  counts: z.object({
    native: z.number().int().nonnegative(),
    gate: z.number().int().nonnegative(),
    buy: z.number().int().nonnegative(),
    none: z.number().int().nonnegative(),
  }),
  /** Its verified downloads on disk, which deleting the playlist removes. */
  downloads: z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
  }),
});
export type PlaylistSummaryDto = z.infer<typeof playlistSummarySchema>;

export const listPlaylistsResponseSchema = z.object({
  playlists: z.array(playlistSummarySchema),
});
export type ListPlaylistsResponse = z.infer<typeof listPlaylistsResponseSchema>;

/** Where a track's most recent browser job stands. */
const trackJobSchema = z.object({
  status: jobStatusSchema,
  /** The step a running or waiting job is on. */
  stepName: z.string().nullable(),
  /** Set while the job waits for the human. */
  needsHuman: z
    .object({
      reason: humanReasonSchema,
      /** Instruction to the user. */
      description: z.string(),
      screenshotUrl: z.string(),
    })
    .nullable(),
  manual: z.object({ reason: manualReasonSchema, detail: z.string().nullable() }).nullable(),
  error: z.string().nullable(),
});
export type TrackJobDto = z.infer<typeof trackJobSchema>;

const trackDownloadSchema = z.object({
  fileName: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  kind: downloadKindSchema,
});

const trackSchema = z.object({
  id: z.uuid(),
  position: z.number().int().nonnegative(),
  title: z.string(),
  artist: z.string(),
  permalinkUrl: z.string(),
  artworkUrl: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  classification: trackClassificationSchema,
  gatePlatform: z.string().nullable(),
  purchaseUrl: z.string().nullable(),
  purchaseTitle: z.string().nullable(),
  /** The most recent job, or null when the track has never been run. */
  job: trackJobSchema.nullable(),
  /** The verified download, when there is one. */
  download: trackDownloadSchema.nullable(),
});
export type TrackDto = z.infer<typeof trackSchema>;

export const playlistDetailResponseSchema = z.object({
  playlist: playlistSchema,
  tracks: z.array(trackSchema),
});
export type PlaylistDetailResponse = z.infer<typeof playlistDetailResponseSchema>;

/** Which SoundCloud account downloads run as. Never carries the token. */
export const soundcloudAccountResponseSchema = z.discriminatedUnion("connected", [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    username: z.string(),
    connectedAt: z.iso.datetime(),
    /** When SoundCloud last accepted the token. */
    verifiedAt: z.iso.datetime(),
  }),
]);
export type SoundcloudAccountResponse = z.infer<typeof soundcloudAccountResponseSchema>;

/** The `oauth_token` cookie value the owner copied from their browser. */
export const connectSoundcloudRequestSchema = z.object({
  token: soundcloudTokenSchema,
});

/** What clicking "Download tracks" did. */
export const runResponseSchema = z.object({
  /** The run created for tracks that needed a new job, or null when none did. */
  runId: z.uuid().nullable(),
  /** Tracks handed to the worker for the first time (or again after a failure). */
  queued: z.number().int().nonnegative(),
  /** Paused tracks sent back for another look. */
  resumed: z.number().int().nonnegative(),
  alreadyDownloaded: z.number().int().nonnegative(),
  /** Tracks that were already queued or running. */
  alreadyActive: z.number().int().nonnegative(),
});
export type RunResponse = z.infer<typeof runResponseSchema>;

/** What clicking "Cancel" did. */
export const cancelRunResponseSchema = z.object({
  /** Queued tracks that will not be downloaded now. */
  cancelled: z.number().int().nonnegative(),
  /** Tracks downloading at that moment: each finishes, and nothing starts after it. */
  running: z.number().int().nonnegative(),
});
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;

/** What deleting a playlist removed. */
export const deletePlaylistResponseSchema = z.object({
  deletedFiles: z.number().int().nonnegative(),
  freedBytes: z.number().nonnegative(),
});
export type DeletePlaylistResponse = z.infer<typeof deletePlaylistResponseSchema>;
