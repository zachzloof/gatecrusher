import { createDb, schema, type Database } from "@gatecrusher/db";
import { createTestDatabase, type TestDatabase } from "@gatecrusher/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addPlaylistResponseSchema,
  apiErrorSchema,
  listPlaylistsResponseSchema,
  playlistDetailResponseSchema,
} from "./api-schemas";
import { ingestPlaylist } from "./ingest";
import {
  handleAddPlaylist,
  handleGetPlaylist,
  handleListPlaylists,
  type HandlerDeps,
} from "./playlist-handlers";
import { fetchPlaylistFromApiV2 } from "./soundcloud/api-v2";
import { createMemoryClientIdCache } from "./soundcloud/client-id";
import {
  createFakeRunner,
  createFakeSoundcloud,
  fixtureText,
  type FakeSoundcloudOptions,
} from "./soundcloud/testing";
import type { PlaylistSource } from "./soundcloud/types";
import { fetchPlaylistFromYtDlp } from "./soundcloud/yt-dlp";

// Real Postgres (a throwaway database), real ingest and classifier; SoundCloud and
// yt-dlp are played from the recorded fixtures.
let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.handle.db;
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await db.delete(schema.playlists);
});

const PLAYLIST_URL = "https://soundcloud.com/fixture-curator/sets/fixture-crate";
const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

const ytDlpFromFixture: PlaylistSource = (url) =>
  fetchPlaylistFromYtDlp(
    {
      runner: createFakeRunner({ ok: true, stdout: fixtureText("yt-dlp-playlist.json") }),
      command: "yt-dlp",
    },
    url,
  );

const ytDlpNotInstalled: PlaylistSource = (url) =>
  fetchPlaylistFromYtDlp(
    {
      runner: createFakeRunner({ ok: false, kind: "not_installed", detail: "not found" }),
      command: "yt-dlp",
    },
    url,
  );

function depsWith(
  soundcloud: FakeSoundcloudOptions = {},
  ytDlp: PlaylistSource = ytDlpNotInstalled,
  database_: Database = db,
) {
  const fake = createFakeSoundcloud(soundcloud);
  const clientIds = createMemoryClientIdCache();
  const ytDlpCalls: string[] = [];
  const deps: HandlerDeps = {
    db: database_,
    log: silentLog,
    ingest: (playlistUrl) =>
      ingestPlaylist(
        {
          db: database_,
          log: silentLog,
          apiV2: (url) => fetchPlaylistFromApiV2({ fetch: fake.fetch, clientIds }, url),
          ytDlp: (url) => {
            ytDlpCalls.push(url);
            return ytDlp(url);
          },
        },
        playlistUrl,
      ),
  };
  return { deps, fake, ytDlpCalls };
}

function post(body: unknown, deps: HandlerDeps): Promise<Response> {
  return handleAddPlaylist(
    new Request("http://localhost/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps,
  );
}

async function errorOf(response: Response) {
  return apiErrorSchema.parse(await response.json()).error;
}

describe("POST /api/playlists", () => {
  it("ingests through api-v2, classifies every track and stores them", async () => {
    const { deps, fake, ytDlpCalls } = depsWith();

    const response = await post({ url: ` ${PLAYLIST_URL}/?si=tracking ` }, deps);

    expect(response.status).toBe(201);
    const body = addPlaylistResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      title: "Fixture Crate",
      source: "api_v2",
      trackCount: 6,
      unavailableCount: 1,
    });
    // The canonical URL is what gets resolved, not what was pasted.
    expect(fake.requests.find((url) => url.pathname === "/resolve")?.searchParams.get("url")).toBe(
      PLAYLIST_URL,
    );
    expect(ytDlpCalls).toEqual([]);

    const detail = playlistDetailResponseSchema.parse(
      await (await handleGetPlaylist(body.playlistId, deps)).json(),
    );
    expect(detail.playlist).toMatchObject({
      title: "Fixture Crate",
      owner: "fixture-curator",
      soundcloudUrl: PLAYLIST_URL,
      ingestSource: "api_v2",
    });
    expect(
      detail.tracks.map((track) => [track.title, track.classification, track.gatePlatform]),
    ).toEqual([
      ["Native Download (Original Mix)", "native", null],
      ["Gated Bootleg", "gate", "hypeddit"],
      ["Label Release", "buy", null],
      ["Stream Only", "none", null],
      ["Short Link Free DL", "gate", "unknown"],
      ["Download Cap Used Up", "buy", null],
    ]);
  });

  it("updates rather than duplicates when the same playlist is ingested again", async () => {
    const { deps } = depsWith();

    const first = addPlaylistResponseSchema.parse(
      await (await post({ url: PLAYLIST_URL }, deps)).json(),
    );
    const second = addPlaylistResponseSchema.parse(
      await (
        await post({ url: "https://m.soundcloud.com/fixture-curator/sets/fixture-crate" }, deps)
      ).json(),
    );

    expect(second.playlistId).toBe(first.playlistId);
    expect(await db.$count(schema.playlists)).toBe(1);
    expect(await db.$count(schema.tracks)).toBe(6);
  });

  it("falls back to yt-dlp when api-v2 is unavailable, and says so", async () => {
    const { deps, ytDlpCalls } = depsWith({ resolve: { status: 500, body: {} } }, ytDlpFromFixture);

    const response = await post({ url: PLAYLIST_URL }, deps);

    expect(response.status).toBe(201);
    const body = addPlaylistResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ source: "yt_dlp", trackCount: 3, unavailableCount: 1 });
    expect(ytDlpCalls).toEqual([PLAYLIST_URL]);

    const detail = playlistDetailResponseSchema.parse(
      await (await handleGetPlaylist(body.playlistId, deps)).json(),
    );
    expect(detail.playlist.ingestSource).toBe("yt_dlp");
    // yt-dlp has no purchase links or download flags to classify from.
    expect(new Set(detail.tracks.map((track) => track.classification))).toEqual(new Set(["none"]));
  });

  it("answers 404 for a missing or private playlist without trying yt-dlp", async () => {
    const { deps, ytDlpCalls } = depsWith({ resolve: { status: 404, body: {} } }, ytDlpFromFixture);

    const response = await post({ url: PLAYLIST_URL }, deps);

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatchObject({
      code: "playlist_not_found",
      message: "SoundCloud has no public playlist at that URL. It may be private or deleted.",
    });
    expect(ytDlpCalls).toEqual([]);
    expect(await db.$count(schema.playlists)).toBe(0);
  });

  it("answers 422 when the URL resolves to something that is not a playlist", async () => {
    const { deps } = depsWith({ resolve: { status: 200, body: { kind: "user", id: 1 } } });

    const response = await post({ url: PLAYLIST_URL }, deps);

    expect(response.status).toBe(422);
    expect(await errorOf(response)).toEqual({
      code: "not_a_playlist",
      message: "That URL is a SoundCloud user, not a playlist.",
    });
  });

  it("answers 502 with the technical detail when both sources fail", async () => {
    const { deps } = depsWith({ resolve: { status: 500, body: {} } });

    const response = await post({ url: PLAYLIST_URL }, deps);

    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({
      code: "upstream_failed",
      message: "Could not read the playlist from SoundCloud right now. Try again in a minute.",
      detail:
        "SoundCloud API: resolve answered 500. yt-dlp: not installed (install it or set YT_DLP_PATH).",
    });
  });

  it.each([
    ["a track URL", { url: "https://soundcloud.com/some-artist/one-track" }],
    ["another site", { url: "https://example.com/some-artist/sets/x" }],
    ["a localhost URL", { url: "http://localhost:3000/a/sets/b" }],
    ["a missing url", {}],
    ["a non-string url", { url: 42 }],
  ])("rejects %s with a typed 400 and fetches nothing", async (_label, body) => {
    const { deps, fake } = depsWith();

    const response = await post(body, deps);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid_request");
    expect(fake.requests).toEqual([]);
  });

  it("rejects a body that is not JSON with a typed 400", async () => {
    const response = await post("url=nope", depsWith().deps);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid_json");
  });

  it("answers a typed 500 when the database is unreachable", async () => {
    const dead = createDb("postgres://nobody:nothing@127.0.0.1:1/nowhere", { max: 1 });
    try {
      const response = await post(
        { url: PLAYLIST_URL },
        depsWith({}, ytDlpNotInstalled, dead.db).deps,
      );

      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe("internal");
    } finally {
      await dead.close();
    }
  });
});

describe("GET /api/playlists", () => {
  it("is an empty list before anything is ingested", async () => {
    const response = await handleListPlaylists(depsWith().deps);

    expect(response.status).toBe(200);
    expect(listPlaylistsResponseSchema.parse(await response.json())).toEqual({ playlists: [] });
  });

  it("lists playlists with their counts per classification", async () => {
    const { deps } = depsWith();
    await post({ url: PLAYLIST_URL }, deps);

    const body = listPlaylistsResponseSchema.parse(await (await handleListPlaylists(deps)).json());

    expect(body.playlists).toHaveLength(1);
    expect(body.playlists[0]).toMatchObject({
      title: "Fixture Crate",
      ingestSource: "api_v2",
      trackCount: 6,
      counts: { native: 1, gate: 2, buy: 2, none: 1 },
    });
  });
});

describe("GET /api/playlists/:id", () => {
  it.each(["00000000-0000-4000-8000-000000000000", "not-a-uuid", "1; drop table tracks"])(
    "answers 404 for %s",
    async (id) => {
      const response = await handleGetPlaylist(id, depsWith().deps);

      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("not_found");
    },
  );
});
