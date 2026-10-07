// Shapes of the external responses ingest reads. Deliberately loose about everything
// Gatecrusher does not use, so an added or dropped field upstream does not break ingest.
import { z } from "zod";

const apiUserSchema = z.object({
  username: z.string().nullish(),
  avatar_url: z.string().nullish(),
});

/** `/me`: the account a login token belongs to. */
export const apiMeSchema = z.object({
  id: z.number().int(),
  username: z.string(),
});

/** A fully hydrated api-v2 track. */
export const apiTrackSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  permalink_url: z.string(),
  artwork_url: z.string().nullish(),
  /** Milliseconds. */
  duration: z.number().nullish(),
  purchase_url: z.string().nullish(),
  purchase_title: z.string().nullish(),
  downloadable: z.boolean().nullish(),
  has_downloads_left: z.boolean().nullish(),
  user: apiUserSchema.nullish(),
  publisher_metadata: z.object({ artist: z.string().nullish() }).nullish(),
});
export type ApiTrack = z.infer<typeof apiTrackSchema>;

/** Past the first few, a playlist lists its tracks as stubs with little more than an id. */
const apiTrackStubSchema = z.object({ id: z.number().int() });

/** Anything `resolve` can return; `kind` says what the URL points at. */
export const apiResolvedSchema = z.object({ kind: z.string() });

export const apiPlaylistSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  artwork_url: z.string().nullish(),
  secret_token: z.string().nullish(),
  user: apiUserSchema.nullish(),
  tracks: z.array(z.union([apiTrackSchema, apiTrackStubSchema])),
});
export type ApiPlaylist = z.infer<typeof apiPlaylistSchema>;

export const apiTracksResponseSchema = z.array(z.unknown());

const ytDlpId = z.union([z.string(), z.number()]).transform(String);

/** One entry of `yt-dlp -J --flat-playlist`. */
export const ytDlpEntrySchema = z.object({
  id: ytDlpId,
  title: z.string().nullish(),
  url: z.string().nullish(),
  webpage_url: z.string().nullish(),
  uploader: z.string().nullish(),
  /** Seconds. */
  duration: z.number().nullish(),
  thumbnails: z.array(z.object({ url: z.string().nullish() })).nullish(),
});
export type YtDlpEntry = z.infer<typeof ytDlpEntrySchema>;

export const ytDlpPlaylistSchema = z.object({
  _type: z.string().nullish(),
  id: ytDlpId.nullish(),
  title: z.string().nullish(),
  uploader: z.string().nullish(),
  /** `null` entries are tracks yt-dlp could not read. */
  entries: z.array(z.unknown()).nullish(),
});

/** A playlist as the library endpoints list it: the playlist itself, no tracks needed. */
export const apiLibraryPlaylistSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  permalink_url: z.string().nullish(),
  artwork_url: z.string().nullish(),
  sharing: z.string().nullish(),
  secret_token: z.string().nullish(),
  track_count: z.number().nullish(),
  user: apiUserSchema.nullish(),
  /** The first few tracks, when the endpoint includes them; only their artwork is used. */
  tracks: z.array(z.object({ artwork_url: z.string().nullish() })).nullish(),
});
export type ApiLibraryPlaylist = z.infer<typeof apiLibraryPlaylistSchema>;

/**
 * One entry of a library listing. The endpoint wraps each playlist in an item that says
 * whether it is the account's own or a liked one; a bare playlist is accepted too.
 */
export const apiLibraryItemSchema = z.union([
  z.object({ type: z.string().nullish(), playlist: apiLibraryPlaylistSchema }),
  apiLibraryPlaylistSchema.extend({ kind: z.literal("playlist") }),
]);

/** A paged api-v2 listing: `collection` plus the URL of the next page, if any. */
export const apiPagedResponseSchema = z.object({
  collection: z.array(z.unknown()),
  next_href: z.string().nullish(),
});
