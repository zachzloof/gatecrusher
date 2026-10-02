import { describe, expect, it } from "vitest";
import { fetchPlaylistFromApiV2, HYDRATE_BATCH_SIZE } from "./api-v2";
import { createMemoryClientIdCache, discoverClientId } from "./client-id";
import {
  createFakeSoundcloud,
  FIXTURE_CLIENT_ID,
  fixtureJson,
  STALE_CLIENT_ID,
  type FakeSoundcloudOptions,
} from "./testing";

const PLAYLIST_URL = "https://soundcloud.com/fixture-curator/sets/fixture-crate";

function setup(options: FakeSoundcloudOptions = {}, cachedClientId: string | null = null) {
  const soundcloud = createFakeSoundcloud(options);
  const clientIds = createMemoryClientIdCache();
  clientIds.set(cachedClientId);
  const run = () => fetchPlaylistFromApiV2({ fetch: soundcloud.fetch, clientIds }, PLAYLIST_URL);
  return { soundcloud, clientIds, run };
}

function apiTrack(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "track",
    title: `Track ${id}`,
    permalink_url: `https://soundcloud.com/fixture-artist/track-${id}`,
    duration: 180_000,
    user: { username: "fixture-artist" },
    ...overrides,
  };
}

function playlistOf(tracks: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: { id: 9002, kind: "playlist", title: "Built Crate", tracks, ...overrides },
  };
}

describe("discoverClientId", () => {
  it("reads the id out of SoundCloud's own app scripts, ignoring third-party ones", async () => {
    const soundcloud = createFakeSoundcloud();

    const result = await discoverClientId(soundcloud.fetch, 1_000);

    expect(result).toEqual({ ok: true, clientId: FIXTURE_CLIENT_ID });
    expect(soundcloud.requests.map((url) => url.hostname)).not.toContain("analytics.example.com");
  });

  it("reports a failure when soundcloud.com does not answer", async () => {
    const result = await discoverClientId(createFakeSoundcloud({ homeStatus: 503 }).fetch, 1_000);

    expect(result).toEqual({ ok: false, reason: "soundcloud.com answered 503" });
  });

  it("reports a failure when the network is down", async () => {
    const result = await discoverClientId(
      () => Promise.reject(new TypeError("fetch failed")),
      1_000,
    );

    expect(result.ok).toBe(false);
  });
});

describe("fetchPlaylistFromApiV2", () => {
  it("resolves the playlist and hydrates its stub tracks, in playlist order", async () => {
    const { soundcloud, run } = setup();

    const result = await run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.playlist).toMatchObject({
      source: "api_v2",
      soundcloudId: "9001",
      title: "Fixture Crate",
      owner: "fixture-curator",
      // Track 106 is listed by the playlist but not returned by the track lookup.
      unavailableCount: 1,
    });
    expect(result.playlist.tracks.map((track) => track.soundcloudId)).toEqual([
      "101",
      "102",
      "103",
      "104",
      "105",
      "107",
    ]);
    expect(
      soundcloud.requests.find((url) => url.pathname === "/resolve")?.searchParams.get("url"),
    ).toBe(PLAYLIST_URL);
  });

  it("maps the fields the classifier and the UI need", async () => {
    const result = await setup().run();
    if (!result.ok) throw new Error(result.reason);
    const byId = new Map(result.playlist.tracks.map((track) => [track.soundcloudId, track]));

    expect(byId.get("101")).toEqual({
      soundcloudId: "101",
      title: "Native Download (Original Mix)",
      artist: "Fixture Artist",
      permalinkUrl: "https://soundcloud.com/fixture-artist/native-download",
      artworkUrl: "https://i1.sndcdn.com/artworks-fixture-101-large.jpg",
      durationMs: 301_000,
      purchaseUrl: null,
      purchaseTitle: null,
      downloadable: true,
    });
    expect(byId.get("102")).toMatchObject({
      purchaseUrl: "https://hypeddit.com/track/fixture1",
      purchaseTitle: "Free Download",
      downloadable: false,
    });
    // No artwork of its own: the uploader's avatar stands in.
    expect(byId.get("103")?.artworkUrl).toBe(
      "https://i1.sndcdn.com/avatars-fixture-fixture-artist-large.jpg",
    );
    // No publisher metadata: the uploader's name is the artist.
    expect(byId.get("105")?.artist).toBe("fixture-artist");
    // Downloadable, but the download cap is used up.
    expect(byId.get("107")?.downloadable).toBe(false);
  });

  it("discovers the client_id once and caches it", async () => {
    const { soundcloud, clientIds, run } = setup();

    await run();
    const scriptFetches = soundcloud.requests.filter((url) => url.hostname === "a-v2.sndcdn.com");
    await run();

    expect(clientIds.get()).toBe(FIXTURE_CLIENT_ID);
    expect(soundcloud.count("/")).toBe(1);
    expect(soundcloud.requests.filter((url) => url.hostname === "a-v2.sndcdn.com")).toHaveLength(
      scriptFetches.length,
    );
  });

  it("uses a cached client_id without discovering one", async () => {
    const { soundcloud, run } = setup({}, FIXTURE_CLIENT_ID);

    expect((await run()).ok).toBe(true);
    expect(soundcloud.count("/")).toBe(0);
  });

  it.each([401, 403] as const)(
    "re-resolves the client_id when the cached one is rejected with %s",
    async (rejectStatus) => {
      const { soundcloud, clientIds, run } = setup({ rejectStatus }, STALE_CLIENT_ID);

      const result = await run();

      expect(result.ok).toBe(true);
      expect(clientIds.get()).toBe(FIXTURE_CLIENT_ID);
      expect(soundcloud.count("/")).toBe(1);
      expect(
        soundcloud.requests
          .filter((url) => url.pathname === "/resolve")
          .map((url) => url.searchParams.get("client_id")),
      ).toEqual([STALE_CLIENT_ID, FIXTURE_CLIENT_ID]);
    },
  );

  it("gives up after one re-resolve and never puts the client_id in the reason", async () => {
    const { soundcloud, clientIds, run } = setup({ acceptedClientId: null }, STALE_CLIENT_ID);

    const result = await run();

    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      reason: "SoundCloud API: resolve answered 401",
    });
    expect(soundcloud.count("/resolve")).toBe(2);
    expect(clientIds.get()).toBeNull();
  });

  it("hydrates a long playlist in batches and keeps its order", async () => {
    const ids = Array.from({ length: 130 }, (_, index) => 1_000 + index);
    const { soundcloud, run } = setup({
      // The first five arrive hydrated, as on the real endpoint; the rest are stubs.
      resolve: playlistOf(
        ids.map((id, index) => (index < 5 ? apiTrack(id) : { id, kind: "track" })),
      ),
      tracks: ids.map((id) => apiTrack(id)).reverse(),
    });

    const result = await run();

    if (!result.ok) throw new Error(result.reason);
    expect(result.playlist.tracks.map((track) => Number(track.soundcloudId))).toEqual(ids);
    expect(result.playlist.unavailableCount).toBe(0);
    const batches = soundcloud.requests
      .filter((url) => url.pathname === "/tracks")
      .map((url) => (url.searchParams.get("ids") ?? "").split(",").length);
    expect(batches).toEqual([HYDRATE_BATCH_SIZE, HYDRATE_BATCH_SIZE, 25]);
  });

  it("makes no track lookup when every track arrived hydrated", async () => {
    const { soundcloud, run } = setup({ resolve: playlistOf([apiTrack(1), apiTrack(2)]) });

    expect((await run()).ok).toBe(true);
    expect(soundcloud.count("/tracks")).toBe(0);
  });

  it("keeps a track listed twice only once", async () => {
    const result = await setup({
      resolve: playlistOf([apiTrack(1), apiTrack(2), apiTrack(1)]),
    }).run();

    if (!result.ok) throw new Error(result.reason);
    expect(result.playlist.tracks.map((track) => track.soundcloudId)).toEqual(["1", "2"]);
  });

  it("drops unusable links and counts unusable tracks as unavailable", async () => {
    const result = await setup({
      resolve: playlistOf([
        apiTrack(1, {
          purchase_url: "javascript:alert(1)",
          artwork_url: "http://insecure.example/a.jpg",
        }),
        apiTrack(2, { purchase_url: "hypeddit.com/track/x" }),
        apiTrack(3, { title: "   " }),
        apiTrack(4, { permalink_url: "javascript:alert(1)" }),
      ]),
    }).run();

    if (!result.ok) throw new Error(result.reason);
    expect(result.playlist.tracks).toHaveLength(2);
    expect(result.playlist.tracks[0]).toMatchObject({ purchaseUrl: null, artworkUrl: null });
    expect(result.playlist.tracks[1]?.purchaseUrl).toBe("https://hypeddit.com/track/x");
    expect(result.playlist.unavailableCount).toBe(2);
  });

  it("sends the playlist's secret token with track lookups for a private-link playlist", async () => {
    const { soundcloud, run } = setup({
      resolve: playlistOf([{ id: 103 }], { secret_token: "s-FixtureToken" }),
    });

    expect((await run()).ok).toBe(true);
    const lookup = soundcloud.requests.find((url) => url.pathname === "/tracks");
    expect(lookup?.searchParams.get("playlistId")).toBe("9002");
    expect(lookup?.searchParams.get("playlistSecretToken")).toBe("s-FixtureToken");
  });

  it("accepts an empty playlist", async () => {
    const result = await setup({ resolve: playlistOf([]) }).run();

    expect(result).toMatchObject({ ok: true, playlist: { tracks: [], unavailableCount: 0 } });
  });

  it("answers not_found for a missing or private playlist", async () => {
    const result = await setup({ resolve: { status: 404, body: {} } }).run();

    expect(result).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("answers not_a_playlist when the URL resolves to a track", async () => {
    const result = await setup({
      resolve: { status: 200, body: fixtureJson("resolve-track.json") },
    }).run();

    expect(result).toEqual({
      ok: false,
      kind: "not_a_playlist",
      reason: "That URL is a SoundCloud track, not a playlist.",
    });
  });

  it.each([
    ["a server error", { status: 500, body: {} }],
    ["rate limiting", { status: 429, body: {} }],
    ["a body that is not an object", { status: 200, body: "nope" }],
    ["a playlist without tracks", { status: 200, body: { kind: "playlist", id: 1, title: "x" } }],
  ])("answers unavailable on %s", async (_label, resolve) => {
    expect(await setup({ resolve }).run()).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("answers unavailable when the client_id cannot be discovered", async () => {
    const result = await setup({ homeStatus: 503 }).run();

    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      reason: "SoundCloud API: resolve failed (soundcloud.com answered 503)",
    });
  });

  it("answers unavailable, without the client_id, when the network fails", async () => {
    const clientIds = createMemoryClientIdCache();
    clientIds.set(FIXTURE_CLIENT_ID);

    const result = await fetchPlaylistFromApiV2(
      {
        clientIds,
        fetch: (url) => Promise.reject(new TypeError(`fetch failed for ${url}`)),
      },
      PLAYLIST_URL,
    );

    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(FIXTURE_CLIENT_ID);
  });
});
