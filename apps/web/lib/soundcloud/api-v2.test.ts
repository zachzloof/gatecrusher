import { describe, expect, it } from "vitest";
import {
  fetchMyPlaylists,
  fetchPlaylistFromApiV2,
  HYDRATE_BATCH_SIZE,
  verifySoundcloudToken,
} from "./api-v2";
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

describe("verifySoundcloudToken", () => {
  // Made-up value in the shape SoundCloud uses; never a real token.
  const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";

  function verify(options: FakeSoundcloudOptions) {
    const soundcloud = createFakeSoundcloud(options);
    const clientIds = createMemoryClientIdCache();
    clientIds.set(FIXTURE_CLIENT_ID);
    return {
      soundcloud,
      result: verifySoundcloudToken({ fetch: soundcloud.fetch, clientIds }, TOKEN),
    };
  }

  it("says who the token belongs to, sending it only in the Authorization header", async () => {
    const { soundcloud, result } = verify({
      me: { token: TOKEN, body: { id: 290123, username: "burner-digger", city: "Leeds" } },
    });

    expect(await result).toEqual({
      ok: true,
      soundcloudUserId: "290123",
      username: "burner-digger",
    });
    expect(soundcloud.headers).toEqual([{ Authorization: `OAuth ${TOKEN}` }]);
    expect(soundcloud.requests.map((url) => url.toString()).join(" ")).not.toContain(TOKEN);
  });

  it("reports a token SoundCloud refuses as rejected, without repeating it", async () => {
    const { result } = verify({ me: { token: "2-other-token-0000000000", body: {} } });

    const answer = await result;
    expect(answer).toMatchObject({ ok: false, kind: "rejected" });
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it("reports an unexpected /me answer as unavailable", async () => {
    const { result } = verify({ me: { token: TOKEN, body: { nope: true } } });

    expect(await result).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("reports SoundCloud being down as unavailable, not as a bad token", async () => {
    const { result } = verify({ me: { token: TOKEN, status: 503, body: {} } });

    expect(await result).toMatchObject({ ok: false, kind: "unavailable" });
  });
});

describe("fetchMyPlaylists", () => {
  // Made-up value in the shape SoundCloud uses; never a real token.
  const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";
  const USER_ID = "290123";
  const page = (body: unknown, status = 200) => ({ status, body });
  const empty = () => page({ collection: [], next_href: null });
  /** The signed-in library, the public own playlists, no albums, two pages of likes. */
  const fixtureListings = () => ({
    "me/library/all": [page(fixtureJson("my-library.json"))],
    playlists_without_albums: [page(fixtureJson("my-own-playlists.json"))],
    albums: [empty()],
    "playlists/liked_and_owned": [
      page(fixtureJson("my-playlists-page1.json")),
      page(fixtureJson("my-playlists-page2.json")),
    ],
  });

  function list(options: FakeSoundcloudOptions, userId = USER_ID) {
    const soundcloud = createFakeSoundcloud(options);
    const clientIds = createMemoryClientIdCache();
    clientIds.set(FIXTURE_CLIENT_ID);
    const listings = (path: string) =>
      soundcloud.requests.filter(
        (url) =>
          url.pathname === (path.startsWith("me/") ? `/${path}` : `/users/${USER_ID}/${path}`),
      );
    return {
      soundcloud,
      listings,
      result: fetchMyPlaylists({ fetch: soundcloud.fetch, clientIds }, TOKEN, userId),
    };
  }

  it("lists the signed-in library first, then the public listings, each once", async () => {
    const { listings, result } = list({
      library: { token: TOKEN, userId: USER_ID, listings: fixtureListings() },
    });

    const answer = await result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.playlists.map((playlist) => playlist.soundcloudId)).toEqual([
      "9011",
      "9010",
      "9003",
      "9001",
      "9002",
      "9005",
    ]);
    // An own private playlist, from the signed-in library: the URL carries the share token.
    expect(answer.playlists[0]).toMatchObject({
      title: "Unreleased Edits",
      url: "https://soundcloud.com/burner-digger/sets/unreleased-edits/s-OwNpRiV2",
      isPrivate: true,
      liked: false,
    });
    // An own playlist, public.
    expect(answer.playlists[1]).toEqual({
      soundcloudId: "9010",
      title: "Warm Up Selections",
      url: "https://soundcloud.com/burner-digger/sets/warm-up-selections",
      artworkUrl: "https://i1.sndcdn.com/artworks-fixture-9010-t300x300.jpg",
      owner: "burner-digger",
      trackCount: 18,
      isPrivate: false,
      liked: false,
    });
    // Liked in the library, and listed again among the likes: once.
    expect(answer.playlists[2]).toMatchObject({ owner: "other-dj", liked: true });
    // Listed as own and again among the likes: once, as own.
    expect(answer.playlists[3]).toMatchObject({ title: "Fixture Crate", liked: false });
    // A private one from the likes listing: the first track's cover stands in.
    expect(answer.playlists[4]).toMatchObject({
      title: "Secret Weapons",
      url: "https://soundcloud.com/burner-digger/sets/secret-weapons/s-FiXtUrE1",
      artworkUrl: "https://i1.sndcdn.com/artworks-fixture-202-t300x300.jpg",
      isPrivate: true,
    });
    expect(answer.playlists[5]).toMatchObject({
      title: "Untitled playlist",
      artworkUrl: null,
      trackCount: 0,
    });

    expect(listings("me/library/all")).toHaveLength(1);
    expect(listings("playlists_without_albums")).toHaveLength(1);
    expect(listings("albums")).toHaveLength(1);
    // What each listing contributed: the system playlist is "other", the playlist
    // without a link "unusable"; duplicates still count as playlists here.
    expect(answer.listings).toEqual([
      { path: "/me/library/all", items: 4, playlists: 3, unusable: 0, other: 1 },
      // Not served by the fake: reported as a listing SoundCloud does not have.
      { path: "/me/playlists", items: null, playlists: 0, unusable: 0, other: 0 },
      {
        path: "/users/290123/playlists_without_albums",
        items: 3,
        playlists: 3,
        unusable: 0,
        other: 0,
      },
      { path: "/users/290123/albums", items: 0, playlists: 0, unusable: 0, other: 0 },
      {
        path: "/users/290123/playlists/liked_and_owned",
        items: 7,
        playlists: 5,
        unusable: 1,
        other: 1,
      },
    ]);
    const likes = listings("playlists/liked_and_owned");
    expect(likes.map((url) => url.searchParams.get("limit"))).toEqual(["200", "200"]);
    expect(likes[1]?.searchParams.get("offset")).toBe("2026-09-01T10:00:00Z,playlist,9004");
    expect(likes[1]?.searchParams.get("client_id")).toBe(FIXTURE_CLIENT_ID);
  });

  it("sends the token only in the Authorization header", async () => {
    const { soundcloud, result } = list({
      library: { token: TOKEN, userId: USER_ID, listings: fixtureListings() },
    });

    await result;
    expect(soundcloud.headers.every((sent) => sent.Authorization === `OAuth ${TOKEN}`)).toBe(true);
    expect(soundcloud.requests.map((url) => url.toString()).join(" ")).not.toContain(TOKEN);
  });

  it("reports a token SoundCloud refuses as rejected, without repeating it", async () => {
    const { result } = list({
      library: { token: "2-other-token-0000000000", userId: USER_ID, listings: fixtureListings() },
    });

    const answer = await result;
    expect(answer).toMatchObject({ ok: false, kind: "rejected" });
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it("reports a listing SoundCloud answers 404 for as missing, and goes on", async () => {
    const listings = fixtureListings();
    const { result } = list({
      library: { token: TOKEN, userId: USER_ID, listings: { ...listings, albums: [] } },
    });

    const answer = await result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.playlists).toHaveLength(6);
    expect(answer.listings[3]).toEqual({
      path: "/users/290123/albums",
      items: null,
      playlists: 0,
      unusable: 0,
      other: 0,
    });
  });

  it("does not add the share token twice when the link already carries it", async () => {
    const { result } = list({
      library: {
        token: TOKEN,
        userId: USER_ID,
        listings: {
          "me/library/all": [
            page({
              collection: [
                {
                  type: "playlist",
                  playlist: {
                    id: 42,
                    kind: "playlist",
                    title: "Already tokenised",
                    permalink_url: "https://soundcloud.com/burner-digger/sets/edits/s-AbC123",
                    sharing: "private",
                    secret_token: "s-AbC123",
                  },
                },
              ],
              next_href: null,
            }),
          ],
        },
      },
    });

    const answer = await result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.playlists.map((playlist) => playlist.url)).toEqual([
      "https://soundcloud.com/burner-digger/sets/edits/s-AbC123",
    ]);
  });

  it("reports SoundCloud being down as unavailable, naming the listing", async () => {
    const { result } = list({
      library: {
        token: TOKEN,
        userId: USER_ID,
        listings: { ...fixtureListings(), albums: [page({}, 503)] },
      },
    });

    expect(await result).toEqual({
      ok: false,
      kind: "unavailable",
      reason: "/users/290123/albums listing answered 503",
    });
  });

  it("reports an unexpected answer as unavailable", async () => {
    const { result } = list({
      library: {
        token: TOKEN,
        userId: USER_ID,
        listings: { ...fixtureListings(), playlists_without_albums: [page({ nope: 1 })] },
      },
    });

    expect(await result).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("stops at an empty page and at a next_href that leaves api-v2", async () => {
    const elsewhere = page({
      collection: [
        {
          type: "playlist",
          playlist: {
            id: 1,
            kind: "playlist",
            title: "x",
            permalink_url: "https://soundcloud.com/a/sets/b",
          },
        },
      ],
      next_href: "https://evil.example.com/next",
    });
    const { listings, result } = list({
      library: {
        token: TOKEN,
        userId: USER_ID,
        listings: {
          "me/library/all": [empty()],
          playlists_without_albums: [empty()],
          albums: [empty()],
          "playlists/liked_and_owned": [elsewhere, empty()],
        },
      },
    });

    const answer = await result;
    expect(answer).toMatchObject({ ok: true });
    expect(listings("playlists/liked_and_owned")).toHaveLength(1);
  });
});
