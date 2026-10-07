import { createDb, saveSoundcloudAccount, schema, type Database } from "@gatecrusher/db";
import { createTestDatabase, type TestDatabase } from "@gatecrusher/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  myPlaylistsResponseSchema,
  type ListingReport,
  type MyPlaylistDto,
} from "./api-schemas";
import { handleListMyPlaylists, type MyPlaylistsHandlerDeps } from "./my-playlists-handlers";
import type { MyPlaylistsResult } from "./soundcloud/api-v2";

// Real Postgres (a throwaway database); SoundCloud's answer is a fake that records what
// it was asked for.
// Made-up value in the shape SoundCloud uses; never a real token.
const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";

const PLAYLIST: MyPlaylistDto = {
  soundcloudId: "9001",
  title: "Fixture Crate",
  url: "https://soundcloud.com/fixture-curator/sets/fixture-crate",
  artworkUrl: null,
  owner: "burner-digger",
  trackCount: 7,
  isPrivate: false,
  liked: false,
};

const LISTINGS: ListingReport[] = [
  { path: "/me/library/all", items: 1, playlists: 1, unusable: 0, other: 0 },
];

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
  await db.delete(schema.soundcloudAccount);
});

const log = { error: () => undefined };

function depsWith(
  answer: MyPlaylistsResult = { ok: true, playlists: [PLAYLIST], listings: LISTINGS },
  database_: Database = db,
) {
  const asked: Array<{ token: string; userId: string }> = [];
  const deps: MyPlaylistsHandlerDeps = {
    db: database_,
    log,
    listPlaylists: (token, userId) => {
      asked.push({ token, userId });
      return Promise.resolve(answer);
    },
  };
  return { deps, asked };
}

async function connect(): Promise<void> {
  await saveSoundcloudAccount(db, {
    oauthToken: TOKEN,
    soundcloudUserId: "290123",
    username: "burner-digger",
  });
}

async function errorOf(response: Response) {
  return apiErrorSchema.parse(await response.json()).error;
}

describe("GET /api/soundcloud-account/playlists", () => {
  it("answers 409 when no account is connected, without asking SoundCloud", async () => {
    const { deps, asked } = depsWith();

    const response = await handleListMyPlaylists(deps);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("soundcloud_not_connected");
    expect(asked).toEqual([]);
  });

  it("lists the playlists using the stored token and user id", async () => {
    await connect();
    const { deps, asked } = depsWith();

    const response = await handleListMyPlaylists(deps);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(myPlaylistsResponseSchema.parse(await response.json())).toEqual({
      playlists: [PLAYLIST],
      listings: LISTINGS,
    });
    expect(asked).toEqual([{ token: TOKEN, userId: "290123" }]);
  });

  it("answers 422 when SoundCloud refuses the saved token, never repeating it", async () => {
    await connect();
    const { deps } = depsWith({ ok: false, kind: "rejected", reason: "SoundCloud answered 401" });

    const response = await handleListMyPlaylists(deps);

    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("soundcloud_token_rejected");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("answers 502 when SoundCloud cannot be read", async () => {
    await connect();
    const { deps } = depsWith({
      ok: false,
      kind: "unavailable",
      reason: "playlist listing answered 503",
    });

    const response = await handleListMyPlaylists(deps);

    expect(response.status).toBe(502);
    expect(await errorOf(response)).toMatchObject({
      code: "upstream_failed",
      detail: "playlist listing answered 503",
    });
  });

  it("answers a typed 500 when the database is unreachable", async () => {
    const dead = createDb("postgres://nobody:nothing@127.0.0.1:1/nowhere", { max: 1 });
    try {
      const response = await handleListMyPlaylists(depsWith(undefined, dead.db).deps);

      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe("internal");
    } finally {
      await dead.close();
    }
  });
});
