import type { IngestedPlaylist } from "@gatecrusher/core";

/** The slice of `fetch` the SoundCloud clients use, so tests can hand in a fake. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/**
 * What a metadata source (api-v2 or yt-dlp) answers for a playlist URL.
 * `not_found` and `not_a_playlist` are answers about the URL; `unavailable` means the
 * source itself could not be used and another one is worth trying.
 */
export type SourceResult =
  | { ok: true; playlist: IngestedPlaylist }
  | { ok: false; kind: "not_found" | "not_a_playlist" | "unavailable"; reason: string };

export type PlaylistSource = (playlistUrl: string) => Promise<SourceResult>;
