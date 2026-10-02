import { z } from "zod";
import { ingestSourceSchema } from "./domain.ts";

/**
 * One track's metadata as a source (api-v2 or yt-dlp) reports it, already reduced to
 * what Gatecrusher keeps. Links are absolute http(s) URLs or null.
 */
export const ingestedTrackSchema = z.object({
  soundcloudId: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1),
  permalinkUrl: z.url({ protocol: /^https$/ }),
  artworkUrl: z.url({ protocol: /^https$/ }).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  purchaseUrl: z.url({ protocol: /^https?$/ }).nullable(),
  purchaseTitle: z.string().nullable(),
  /** SoundCloud's own download is enabled and has downloads left. */
  downloadable: z.boolean(),
});
export type IngestedTrack = z.infer<typeof ingestedTrackSchema>;

export const ingestedPlaylistSchema = z.object({
  source: ingestSourceSchema,
  soundcloudId: z.string().min(1).nullable(),
  title: z.string().min(1),
  owner: z.string().nullable(),
  artworkUrl: z.url({ protocol: /^https$/ }).nullable(),
  /** In playlist order, without duplicates. */
  tracks: z.array(ingestedTrackSchema),
  /** Tracks the playlist lists but the source would not return (private, removed, geo-blocked). */
  unavailableCount: z.number().int().nonnegative(),
});
export type IngestedPlaylist = z.infer<typeof ingestedPlaylistSchema>;
