import type { IngestedTrack } from "@gatecrusher/core";
import { describeError, discoverClientId, type ClientIdCache } from "./client-id";
import { httpsUrl, trackFromApi } from "./map-track";
import {
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
      const response = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
