import { createDb, getSoundcloudOauthToken, schema, type Database } from "@gatecrusher/db";
import { createTestDatabase, type TestDatabase } from "@gatecrusher/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  handleConnectAccount,
  handleDisconnectAccount,
  handleGetAccount,
  type AccountHandlerDeps,
} from "./account-handlers";
import { apiErrorSchema, soundcloudAccountResponseSchema } from "./api-schemas";
import type { VerifyTokenResult } from "./soundcloud/api-v2";

// Real Postgres (a throwaway database); SoundCloud's answer is a fake that records which
// tokens it was asked about.
// Made-up values in the shape SoundCloud uses; never real tokens.
const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";
const OTHER_TOKEN = "2-290123-987654321-zYxWvUtSrQpOnM";

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
  answer: VerifyTokenResult = { ok: true, soundcloudUserId: "290123", username: "burner-digger" },
  database_: Database = db,
) {
  const asked: string[] = [];
  const deps: AccountHandlerDeps = {
    db: database_,
    log,
    verifyToken: (token) => {
      asked.push(token);
      return Promise.resolve(answer);
    },
  };
  return { deps, asked };
}

function put(body: unknown): Request {
  return new Request("http://127.0.0.1/api/soundcloud-account", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function accountOf(response: Response) {
  return soundcloudAccountResponseSchema.parse(await response.json());
}

async function errorOf(response: Response) {
  return apiErrorSchema.parse(await response.json()).error;
}

describe("GET /api/soundcloud-account", () => {
  it("says nobody is connected at first", async () => {
    const response = await handleGetAccount(depsWith().deps);

    expect(response.status).toBe(200);
    expect(await accountOf(response)).toEqual({ connected: false });
  });

  it("answers a typed 500 when the database is unreachable", async () => {
    const dead = createDb("postgres://nobody:nothing@127.0.0.1:1/nowhere", { max: 1 });
    try {
      const response = await handleGetAccount(depsWith(undefined, dead.db).deps);

      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe("internal");
    } finally {
      await dead.close();
    }
  });
});

describe("PUT /api/soundcloud-account", () => {
  it("checks the token with SoundCloud, stores it, and never sends it back", async () => {
    const { deps, asked } = depsWith();

    const response = await handleConnectAccount(put({ token: `  oauth_token=${TOKEN} ` }), deps);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(soundcloudAccountResponseSchema.parse(JSON.parse(text))).toMatchObject({
      connected: true,
      username: "burner-digger",
    });
    // Normalised before it was checked and stored.
    expect(asked).toEqual([TOKEN]);
    expect(await getSoundcloudOauthToken(db)).toBe(TOKEN);

    const get = await handleGetAccount(deps);
    const getText = await get.text();
    expect(getText).not.toContain(TOKEN);
    expect(JSON.parse(getText)).toMatchObject({ connected: true, username: "burner-digger" });
  });

  it("replaces the stored token when connecting again", async () => {
    await handleConnectAccount(put({ token: TOKEN }), depsWith().deps);

    await handleConnectAccount(put({ token: OTHER_TOKEN }), depsWith().deps);

    expect(await getSoundcloudOauthToken(db)).toBe(OTHER_TOKEN);
    expect(await db.$count(schema.soundcloudAccount)).toBe(1);
  });

  it("stores nothing when SoundCloud refuses the token, and says what to check", async () => {
    const { deps } = depsWith({ ok: false, kind: "rejected", reason: "SoundCloud answered 401" });

    const response = await handleConnectAccount(put({ token: TOKEN }), deps);

    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    const { error } = apiErrorSchema.parse(JSON.parse(text));
    expect(error.code).toBe("soundcloud_token_rejected");
    expect(error.message).toContain("whole oauth_token value");
    expect(await getSoundcloudOauthToken(db)).toBeNull();
  });

  it("keeps the earlier login when a new token is refused", async () => {
    await handleConnectAccount(put({ token: TOKEN }), depsWith().deps);

    await handleConnectAccount(
      put({ token: OTHER_TOKEN }),
      depsWith({ ok: false, kind: "rejected", reason: "SoundCloud answered 401" }).deps,
    );

    expect(await getSoundcloudOauthToken(db)).toBe(TOKEN);
  });

  it("stores nothing when SoundCloud cannot be reached", async () => {
    const { deps } = depsWith({ ok: false, kind: "unavailable", reason: "/me answered 503" });

    const response = await handleConnectAccount(put({ token: TOKEN }), deps);

    expect(response.status).toBe(502);
    expect(await errorOf(response)).toMatchObject({ code: "upstream_failed" });
    expect(await getSoundcloudOauthToken(db)).toBeNull();
  });

  it.each([
    ["not JSON", "{", 400, "invalid_json"],
    ["no token", {}, 400, "invalid_request"],
    ["a token with a newline inside", { token: `${TOKEN}\nx` }, 400, "invalid_request"],
    ["a whole cookie header", { token: `a=b; oauth_token=${TOKEN}` }, 400, "invalid_request"],
  ])("refuses %s without asking SoundCloud", async (_label, body, status, code) => {
    const { deps, asked } = depsWith();

    const response = await handleConnectAccount(put(body), deps);

    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(apiErrorSchema.parse(JSON.parse(text)).error.code).toBe(code);
    expect(asked).toEqual([]);
  });
});

describe("DELETE /api/soundcloud-account", () => {
  it("forgets the login, and is safe to repeat", async () => {
    await handleConnectAccount(put({ token: TOKEN }), depsWith().deps);

    const first = await handleDisconnectAccount(depsWith().deps);
    const second = await handleDisconnectAccount(depsWith().deps);

    expect(await accountOf(first)).toEqual({ connected: false });
    expect(await accountOf(second)).toEqual({ connected: false });
    expect(await getSoundcloudOauthToken(db)).toBeNull();
  });
});
