import type { IngestedTrack } from "@gatecrusher/core";
import { myPlaylistSchema, type ListingReport, type MyPlaylistDto } from "../api-schemas";
import { describeError, discoverClientId, type ClientIdCache } from "./client-id";
import { httpsUrl, trackFromApi } from "./map-track";
import {
  apiLibraryItemSchema,
  apiMeSchema,
  apiPagedResponseSchema,
  apiPlaylistSchema,
  apiResolvedSchema,
  apiTrackSchema,
  apiTracksResponseSchema,
  type ApiTrack,
} from "./schemas";
import type { FetchLike, SourceResult } from "./types";

const API_BASE = "https://api-v2.soundcloud.com";
/** How many track ids one `/tracks?ids=` request may carry. */
export const HYDRATE_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiV2Deps {
  fetch: FetchLike;
  clientIds: ClientIdCache;
  timeoutMs?: number;
}

type ApiResponse =
  | { ok: true; body: unknown }
  | { ok: false; kind: "http"; status: number }
  | { ok: false; kind: "unreachable"; reason: string };

/**
 * One GET against api-v2 with the current `client_id`. On 401/403 the cached id is
 * dropped, a fresh one is discovered and the request is repeated once.
 */
async function apiGet(
  deps: ApiV2Deps,
  path: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (const attempt of [1, 2]) {
    let clientId = deps.clientIds.get();
    if (clientId === null) {
      const discovered = await discoverClientId(deps.fetch, timeoutMs);
      if (!discovered.ok) return { ok: false, kind: "unreachable", reason: discovered.reason };
      clientId = discovered.clientId;
      deps.clientIds.set(clientId);
    }

    const url = `${API_BASE}${path}?${new URLSearchParams({ ...params, client_id: clientId }).toString()}`;
    try {
      const response = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
      if (response.status === 401 || response.status === 403) {
        deps.clientIds.set(null);
        if (attempt === 1) continue;
      }
      if (!response.ok) return { ok: false, kind: "http", status: response.status };
      return { ok: true, body: await response.json() };
    } catch (error) {
      // Network failure, timeout or a body that is not JSON.
      return { ok: false, kind: "unreachable", reason: describeError(error) };
    }
  }
  // Unreachable: the second attempt always returns. Kept so every path has a result.
  return { ok: false, kind: "unreachable", reason: "no response from api-v2" };
}

export type VerifyTokenResult =
  | { ok: true; soundcloudUserId: string; username: string }
  /** SoundCloud refused the token: mistyped, expired, or the account signed out. */
  | { ok: false; kind: "rejected"; reason: string }
  /** SoundCloud could not be asked; the token may be fine. */
  | { ok: false; kind: "unavailable"; reason: string };

/**
 * Asks api-v2 who a login token belongs to (`/me`), the same check the SoundCloud web
 * app makes. The token travels only in the Authorization header, and never appears in
 * a result or a reason. Never rejects.
 */
export async function verifySoundcloudToken(
  deps: ApiV2Deps,
  oauthToken: string,
): Promise<VerifyTokenResult> {
  const me = await apiGet(deps, "/me", {}, { Authorization: `OAuth ${oauthToken}` });
  if (!me.ok) {
    if (me.kind === "http" && (me.status === 401 || me.status === 403)) {
      return { ok: false, kind: "rejected", reason: `SoundCloud answered ${me.status}` };
    }
    return { ok: false, kind: "unavailable", reason: describeFailure("/me", me) };
  }
  const user = apiMeSchema.safeParse(me.body);
  if (!user.success) {
    return { ok: false, kind: "unavailable", reason: "/me returned an unexpected response" };
  }
  return {
    ok: true,
    soundcloudUserId: String(user.data.id),
    username: user.data.username.trim() || `user ${user.data.id}`,
  };
}

function unavailable(reason: string): SourceResult {
  return { ok: false, kind: "unavailable", reason: `SoundCloud API: ${reason}` };
}

function describeFailure(what: string, response: Exclude<ApiResponse, { ok: true }>): string {
  return response.kind === "http"
    ? `${what} answered ${response.status}`
    : `${what} failed (${response.reason})`;
}

/**
 * Reads a playlist through SoundCloud's api-v2: `resolve` for the playlist, then
 * `/tracks?ids=` in batches for every track the playlist only lists as a stub.
 * Never rejects.
 */
export async function fetchPlaylistFromApiV2(
  deps: ApiV2Deps,
  playlistUrl: string,
): Promise<SourceResult> {
  const resolved = await apiGet(deps, "/resolve", { url: playlistUrl });
  if (!resolved.ok) {
    if (resolved.kind === "http" && resolved.status === 404) {
      return {
        ok: false,
        kind: "not_found",
        reason: "SoundCloud has no public playlist at that URL. It may be private or deleted.",
      };
    }
    return unavailable(describeFailure("resolve", resolved));
  }

  const kind = apiResolvedSchema.safeParse(resolved.body);
  if (!kind.success) return unavailable("resolve returned an unexpected response");
  if (kind.data.kind !== "playlist") {
    return {
      ok: false,
      kind: "not_a_playlist",
      reason: `That URL is a SoundCloud ${kind.data.kind}, not a playlist.`,
    };
  }
  const playlist = apiPlaylistSchema.safeParse(resolved.body);
  if (!playlist.success) return unavailable("resolve returned an unexpected playlist shape");

  // Playlist order, each id once.
  const orderedIds = [...new Set(playlist.data.tracks.map((track) => track.id))];
  const full = new Map<number, ApiTrack>();
  for (const track of playlist.data.tracks) {
    if ("title" in track) full.set(track.id, track);
  }

  const stubIds = orderedIds.filter((id) => !full.has(id));
  const secret = playlist.data.secret_token;
  for (let start = 0; start < stubIds.length; start += HYDRATE_BATCH_SIZE) {
    const batch = stubIds.slice(start, start + HYDRATE_BATCH_SIZE);
    const hydrated = await apiGet(deps, "/tracks", {
      ids: batch.join(","),
      // A private-link playlist only hands out its tracks together with its token.
      ...(secret !== null && secret !== undefined
        ? { playlistId: String(playlist.data.id), playlistSecretToken: secret }
        : {}),
    });
    if (!hydrated.ok) return unavailable(describeFailure("track lookup", hydrated));

    const list = apiTracksResponseSchema.safeParse(hydrated.body);
    if (!list.success) return unavailable("track lookup returned an unexpected response");
    for (const item of list.data) {
      // A track that does not parse is counted as unavailable below, not fatal.
      const track = apiTrackSchema.safeParse(item);
      if (track.success) full.set(track.data.id, track.data);
    }
  }

  const tracks: IngestedTrack[] = [];
  for (const id of orderedIds) {
    const track = full.get(id);
    const mapped = track === undefined ? null : trackFromApi(track);
    if (mapped !== null) tracks.push(mapped);
  }

  return {
    ok: true,
    playlist: {
      source: "api_v2",
      soundcloudId: String(playlist.data.id),
      title: playlist.data.title.trim() || "Untitled playlist",
      owner: playlist.data.user?.username?.trim() || null,
      artworkUrl: httpsUrl(playlist.data.artwork_url) ?? tracks[0]?.artworkUrl ?? null,
      tracks,
      unavailableCount: orderedIds.length - tracks.length,
    },
  };
}

/** How many playlists one library page may carry; api-v2's own maximum. */
export const LIBRARY_PAGE_SIZE = 200;
/** Enough for 2000 playlists; keeps a broken `next_href` from paging forever. */
const MAX_LIBRARY_PAGES = 10;

export type MyPlaylistsResult =
  | { ok: true; playlists: MyPlaylistDto[]; listings: ListingReport[] }
  /** SoundCloud refused the token: expired, or the account signed out. */
  | { ok: false; kind: "rejected"; reason: string }
  | { ok: false; kind: "unavailable"; reason: string };

/** Asks for a bigger rendition of a SoundCloud cover: the listing hands out 100px ones. */
function largerArtwork(url: string | null): string | null {
  return url === null ? null : url.replace(/-large\.(jpe?g|png)$/i, "-t300x300.$1");
}

/** A private playlist's link with its share token, unless the link already carries it. */
function shareUrl(permalink: string, secretToken: string | null | undefined): string {
  const secret = secretToken?.trim();
  const trimmed = permalink.replace(/\/$/, "");
  if (!secret || trimmed.endsWith(`/${secret}`)) return trimmed;
  return `${trimmed}/${secret}`;
}

/**
 * A library item as one playlist for the UI. `other` is an item that is not a playlist
 * (a system playlist, say); `unusable` a playlist without a link, or with a link that
 * is not a playlist URL.
 */
function myPlaylistFromApi(item: unknown): MyPlaylistDto | "other" | "unusable" {
  const parsed = apiLibraryItemSchema.safeParse(item);
  if (!parsed.success) return "other";
  const liked = "playlist" in parsed.data && parsed.data.type === "playlist-like";
  const playlist = "playlist" in parsed.data ? parsed.data.playlist : parsed.data;

  const permalink = httpsUrl(playlist.permalink_url);
  if (permalink === null) return "unusable";
  const url = shareUrl(permalink, playlist.secret_token);

  const trackArtwork = playlist.tracks?.map((track) => httpsUrl(track.artwork_url)).find(Boolean);
  const candidate: MyPlaylistDto = {
    soundcloudId: String(playlist.id),
    title: playlist.title.trim() || "Untitled playlist",
    url,
    artworkUrl: largerArtwork(httpsUrl(playlist.artwork_url) ?? trackArtwork ?? null),
    owner: playlist.user?.username?.trim() || null,
    trackCount: Math.max(0, Math.round(playlist.track_count ?? playlist.tracks?.length ?? 0)),
    isPrivate: playlist.sharing === "private",
    liked,
  };
  const checked = myPlaylistSchema.safeParse(candidate);
  return checked.success ? checked.data : "unusable";
}

interface Page {
  path: string;
  params: Record<string, string>;
}

/** The path and query of a `next_href`, when it stays on api-v2; the id is re-added. */
function nextPage(href: string | null | undefined): Page | null {
  if (href === null || href === undefined || !URL.canParse(href)) return null;
  const url = new URL(href);
  if (url.origin !== API_BASE) return null;
  const params = Object.fromEntries(url.searchParams);
  delete params.client_id;
  return { path: url.pathname, params };
}

/**
 * The listings behind SoundCloud's own library, in the order the picker shows them.
 * The signed-in listings (`/me/...`) are the ones that can include the account's private
 * playlists: the `/users/{id}/...` listings are the public profile view. Every listing
 * runs; one SoundCloud does not have is reported as missing. `liked` false means every
 * item is the account's own; true means each item says (`type: "playlist-like"`).
 */
const LIBRARY_SOURCES = [
  { path: () => "/me/library/all", liked: true },
  { path: () => "/me/playlists", liked: false },
  { path: (id: string) => `/users/${id}/playlists_without_albums`, liked: false },
  { path: (id: string) => `/users/${id}/albums`, liked: false },
  { path: (id: string) => `/users/${id}/playlists/liked_and_owned`, liked: true },
] as const;

type ListingResult =
  /** `items` is null when SoundCloud has no such listing. */
  | { ok: true; items: unknown[] | null }
  | { ok: false; kind: "rejected" | "unavailable"; reason: string };

/** Every item of one paged listing, following `next_href`. Never rejects. */
async function listAllPages(
  deps: ApiV2Deps,
  first: Page,
  headers: Record<string, string>,
  what: string,
): Promise<ListingResult> {
  const items: unknown[] = [];
  let page: Page | null = first;
  for (let pages = 0; page !== null && pages < MAX_LIBRARY_PAGES; pages += 1) {
    const response = await apiGet(deps, page.path, page.params, headers);
    if (!response.ok) {
      if (response.kind === "http" && (response.status === 401 || response.status === 403)) {
        return { ok: false, kind: "rejected", reason: `SoundCloud answered ${response.status}` };
      }
      // A listing SoundCloud does not have (any more) is reported, not an outage.
      if (response.kind === "http" && response.status === 404) {
        return { ok: true, items: items.length === 0 ? null : items };
      }
      return { ok: false, kind: "unavailable", reason: describeFailure(what, response) };
    }
    const listing = apiPagedResponseSchema.safeParse(response.body);
    if (!listing.success) {
      return { ok: false, kind: "unavailable", reason: `${what} returned an unexpected response` };
    }
    items.push(...listing.data.collection);
    page = listing.data.collection.length === 0 ? null : nextPage(listing.data.next_href);
  }
  return { ok: true, items };
}

/**
 * Lists the playlists of the account a login token belongs to: its own (public and
 * private) and its albums first, then the ones it liked. A playlist listed twice
 * appears once, as the account's own. The token travels only in the Authorization
 * header and never appears in a result or a reason. Never rejects.
 */
export async function fetchMyPlaylists(
  deps: ApiV2Deps,
  oauthToken: string,
  soundcloudUserId: string,
): Promise<MyPlaylistsResult> {
  const headers = { Authorization: `OAuth ${oauthToken}` };
  const seen = new Map<string, MyPlaylistDto>();
  const listings: ListingReport[] = [];

  for (const source of LIBRARY_SOURCES) {
    const path = source.path(encodeURIComponent(soundcloudUserId));
    const listed = await listAllPages(
      deps,
      { path, params: { limit: String(LIBRARY_PAGE_SIZE) } },
      headers,
      `${path} listing`,
    );
    if (!listed.ok) return listed;
    const report: ListingReport = {
      path,
      items: listed.items === null ? null : listed.items.length,
      playlists: 0,
      unusable: 0,
      other: 0,
    };
    for (const item of listed.items ?? []) {
      const playlist = myPlaylistFromApi(item);
      if (playlist === "other" || playlist === "unusable") {
        report[playlist] += 1;
        continue;
      }
      report.playlists += 1;
      if (seen.has(playlist.soundcloudId)) continue;
      // An own listing never holds a liked playlist, whatever the item says.
      seen.set(playlist.soundcloudId, source.liked ? playlist : { ...playlist, liked: false });
    }
    listings.push(report);
  }

  return { ok: true, playlists: [...seen.values()], listings };
}
