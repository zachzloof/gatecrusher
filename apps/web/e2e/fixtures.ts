// API answers for e2e. The ingest is faked at the network boundary: the browser gets
// these instead of the real route handlers, so no database or SoundCloud is involved.
import type { Page } from "@playwright/test";
import type {
  AddPlaylistResponse,
  BuyListResponse,
  ListPlaylistsResponse,
  PlaylistDetailResponse,
  TrackDto,
} from "../lib/api-schemas";

export const PLAYLIST_ID = "11111111-1111-4111-8111-111111111111";
export const PLAYLIST_URL = "https://soundcloud.com/fixture-curator/sets/fixture-crate";

function track(position: number, overrides: Partial<TrackDto>): TrackDto {
  return {
    id: `22222222-2222-4222-8222-${String(position).padStart(12, "0")}`,
    position,
    title: `Track ${position}`,
    artist: "Fixture Artist",
    permalinkUrl: `https://soundcloud.com/fixture-artist/track-${position}`,
    artworkUrl: null,
    durationMs: 240_000 + position * 1_000,
    classification: "none",
    gatePlatform: null,
    purchaseUrl: null,
    purchaseTitle: null,
    job: null,
    download: null,
    ...overrides,
  };
}

export const TRACKS: TrackDto[] = [
  track(0, { title: "Native Download (Original Mix)", classification: "native" }),
  track(1, {
    title: "Gated Bootleg",
    classification: "gate",
    gatePlatform: "hypeddit",
    purchaseUrl: "https://hypeddit.com/track/fixture1",
    purchaseTitle: "Free Download",
  }),
  track(2, {
    title: 'Night "Drive", Pt. 2',
    artist: "=Fixture, The",
    classification: "buy",
    purchaseUrl: "https://fixture-label.bandcamp.com/track/night-drive",
    purchaseTitle: "Buy",
  }),
  track(3, { title: "Stream Only", durationMs: null }),
  track(4, {
    title: "A Short Link Free DL With A Very Long Title That Has To Be Truncated Somewhere",
    classification: "gate",
    gatePlatform: "unknown",
    purchaseUrl: "https://bit.ly/fixture5",
    purchaseTitle: "FREE DL",
  }),
  track(5, {
    title: "Label Release",
    classification: "buy",
    purchaseUrl: "https://www.beatport.com/track/label-release/107",
  }),
];

export const ADDED: AddPlaylistResponse = {
  playlistId: PLAYLIST_ID,
  title: "Fixture Crate",
  source: "api_v2",
  trackCount: TRACKS.length,
  unavailableCount: 1,
};

export const DETAIL: PlaylistDetailResponse = {
  playlist: {
    id: PLAYLIST_ID,
    title: "Fixture Crate",
    owner: "fixture-curator",
    soundcloudUrl: PLAYLIST_URL,
    artworkUrl: null,
    ingestSource: "api_v2",
    lastIngestedAt: "2026-10-01T12:00:00.000Z",
  },
  tracks: TRACKS,
};

export const PLAYLISTS: ListPlaylistsResponse = {
  playlists: [
    { ...DETAIL.playlist, trackCount: 6, counts: { native: 1, gate: 2, buy: 2, none: 1 } },
  ],
};

export const BUY_LIST: BuyListResponse = {
  items: TRACKS.filter((item) => item.classification === "buy").map((item) => ({
    trackId: item.id,
    store: item.purchaseUrl?.includes("bandcamp") === true ? "Bandcamp" : "Beatport",
    title: item.title,
    artist: item.artist,
    purchaseUrl: item.purchaseUrl ?? "",
    permalinkUrl: item.permalinkUrl,
    playlistId: PLAYLIST_ID,
    playlistTitle: "Fixture Crate",
  })),
};

export interface FakeApi {
  playlists?: ListPlaylistsResponse;
  detail?: PlaylistDetailResponse;
  buyList?: BuyListResponse;
}

/** Answers the data routes from memory. Routes that are not listed stay real. */
export async function fakeApi(page: Page, api: FakeApi = {}): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route("**/api/playlists", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(json(api.playlists ?? { playlists: [] }))
      : route.fallback(),
  );
  await page.route("**/api/buy-list", (route) => route.fulfill(json(api.buyList ?? { items: [] })));
  if (api.detail !== undefined) {
    const { detail } = api;
    await page.route(`**/api/playlists/${detail.playlist.id}`, (route) =>
      route.fulfill(json(detail)),
    );
  }
}
