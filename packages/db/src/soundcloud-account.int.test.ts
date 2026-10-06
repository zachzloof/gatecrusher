import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.ts";
import { soundcloudAccount } from "./schema.ts";
import {
  deleteSoundcloudAccount,
  getSoundcloudAccount,
  getSoundcloudOauthToken,
  saveSoundcloudAccount,
} from "./soundcloud-account.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

// Made-up values in the shape SoundCloud uses; never a real token.
const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";

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
  await db.delete(soundcloudAccount);
});

describe("soundcloud account", () => {
  it("is empty until one is connected", async () => {
    expect(await getSoundcloudAccount(db)).toBeNull();
    expect(await getSoundcloudOauthToken(db)).toBeNull();
  });

  it("stores the token and hands it back only through getSoundcloudOauthToken", async () => {
    const saved = await saveSoundcloudAccount(db, {
      oauthToken: TOKEN,
      soundcloudUserId: "290123",
      username: "burner-digger",
    });

    expect(saved).toMatchObject({ soundcloudUserId: "290123", username: "burner-digger" });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.stringify(await getSoundcloudAccount(db))).not.toContain(TOKEN);
    expect(await getSoundcloudOauthToken(db)).toBe(TOKEN);
  });

  it("keeps a single row: connecting again replaces the token", async () => {
    await saveSoundcloudAccount(db, {
      oauthToken: TOKEN,
      soundcloudUserId: "290123",
      username: "burner-digger",
    });
    const first = await getSoundcloudAccount(db);

    await saveSoundcloudAccount(db, {
      oauthToken: `${TOKEN}-renewed`,
      soundcloudUserId: "290123",
      username: "burner-digger-renamed",
    });

    expect(await db.$count(soundcloudAccount)).toBe(1);
    expect(await getSoundcloudOauthToken(db)).toBe(`${TOKEN}-renewed`);
    const second = await getSoundcloudAccount(db);
    expect(second?.username).toBe("burner-digger-renamed");
    // Same account: still connected since the first time.
    expect(second?.connectedAt).toEqual(first?.connectedAt);
  });

  it("counts a different account as a fresh connection", async () => {
    await saveSoundcloudAccount(db, {
      oauthToken: TOKEN,
      soundcloudUserId: "290123",
      username: "burner-digger",
    });
    await db.update(soundcloudAccount).set({ createdAt: new Date("2026-01-01T00:00:00Z") });

    const other = await saveSoundcloudAccount(db, {
      oauthToken: `${TOKEN}-other`,
      soundcloudUserId: "777",
      username: "another-burner",
    });

    expect(other.connectedAt.getTime()).toBeGreaterThan(Date.parse("2026-01-02T00:00:00Z"));
  });

  it("never lets the token into the error when saving fails", async () => {
    const dead = createDb("postgres://nobody:nothing@127.0.0.1:1/nowhere", { max: 1 });
    try {
      const failure: unknown = await saveSoundcloudAccount(dead.db, {
        oauthToken: TOKEN,
        soundcloudUserId: "290123",
        username: "burner-digger",
      }).catch((error: unknown) => error);

      if (!(failure instanceof Error)) throw new Error("expected saving to fail with an Error");
      const error = failure;
      expect(error.message).toMatch(/^Could not save the SoundCloud account/);
      expect(
        JSON.stringify({ ...error, message: error.message, stack: error.stack }),
      ).not.toContain(TOKEN);
      expect(error.cause).toBeUndefined();
    } finally {
      await dead.close();
    }
  });

  it("forgets the login on delete", async () => {
    await saveSoundcloudAccount(db, {
      oauthToken: TOKEN,
      soundcloudUserId: "290123",
      username: "burner-digger",
    });

    expect(await deleteSoundcloudAccount(db)).toBe(true);
    expect(await deleteSoundcloudAccount(db)).toBe(false);
    expect(await getSoundcloudOauthToken(db)).toBeNull();
  });
});
