import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cookieDir, removeStaleCookieFiles, writeSoundcloudCookieFile } from "./cookie-file.ts";

// Made-up values in the shape SoundCloud uses; never a real token.
const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";
const JOB_ID = "44444444-4444-4444-8444-444444444444";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "gatecrusher-cookies-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("writeSoundcloudCookieFile", () => {
  it("writes a Netscape cookie file with only the oauth_token, inside the data dir", async () => {
    const file = await writeSoundcloudCookieFile(
      dataDir,
      JOB_ID,
      TOKEN,
      new Date("2026-10-06T12:00:00Z"),
    );

    expect(path.dirname(file)).toBe(cookieDir(dataDir));
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("# Netscape HTTP Cookie File");
    const cookies = lines.filter((line) => !line.startsWith("# "));
    expect(cookies).toEqual([
      `#HttpOnly_.soundcloud.com\tTRUE\t/\tTRUE\t${Date.parse("2026-10-07T12:00:00Z") / 1000}\toauth_token\t${TOKEN}`,
    ]);
  });

  it.each([
    ["a newline", `${TOKEN}\n.evil.example\tTRUE\t/\tFALSE\t0\tx\ty`],
    ["a tab", `${TOKEN}\tx`],
    ["surrounding quotes", `"${TOKEN}"`],
  ])("refuses a stored token containing %s, writing nothing", async (_label, token) => {
    await expect(writeSoundcloudCookieFile(dataDir, JOB_ID, token)).rejects.toThrow(
      "not in the expected shape",
    );
    await expect(readdir(cookieDir(dataDir))).rejects.toThrow();
  });

  it("refuses a job id that could leave the folder", async () => {
    await expect(writeSoundcloudCookieFile(dataDir, "../../x", TOKEN)).rejects.toThrow();
  });
});

describe("removeStaleCookieFiles", () => {
  it("removes only Gatecrusher's cookie files", async () => {
    await writeSoundcloudCookieFile(dataDir, JOB_ID, TOKEN);
    await writeFile(path.join(cookieDir(dataDir), "other.txt"), "keep");

    await removeStaleCookieFiles(dataDir);

    expect(await readdir(cookieDir(dataDir))).toEqual(["other.txt"]);
  });

  it("does nothing when no file was ever written", async () => {
    await expect(removeStaleCookieFiles(dataDir)).resolves.toBeUndefined();
  });
});
