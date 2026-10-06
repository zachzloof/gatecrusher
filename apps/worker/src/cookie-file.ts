// The SoundCloud login reaches yt-dlp as a cookie file, never on the command line where
// any process on the machine could read it. One file per job, deleted when it ends.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { soundcloudTokenSchema } from "@gatecrusher/core";

const PREFIX = "soundcloud-cookies-";
/** yt-dlp loads expired cookies too; a near expiry just keeps the file honest. */
const LIFETIME_S = 24 * 60 * 60;

/** Where the temporary cookie files live: inside the (gitignored) data dir. */
export function cookieDir(dataDir: string): string {
  return path.join(dataDir, "tmp");
}

/**
 * Writes a Netscape cookie file holding only SoundCloud's `oauth_token`, which is what
 * yt-dlp's SoundCloud extractor reads its login from. Returns the file's path.
 */
export async function writeSoundcloudCookieFile(
  dataDir: string,
  jobId: string,
  oauthToken: string,
  now: Date = new Date(),
): Promise<string> {
  // The token was checked when it was saved; checked again because a tab or newline in
  // it would add lines to the file. Thrown, not returned: a bad stored token is a bug.
  const token = soundcloudTokenSchema.safeParse(oauthToken);
  if (!token.success || token.data !== oauthToken) {
    throw new Error("The stored SoundCloud token is not in the expected shape");
  }
  if (!/^[A-Za-z0-9-]+$/.test(jobId)) throw new Error("Unexpected job id shape");

  const dir = cookieDir(dataDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${PREFIX}${jobId}.txt`);
  const expires = Math.floor(now.getTime() / 1000) + LIFETIME_S;
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Written by Gatecrusher for one yt-dlp run; deleted when the job ends.",
    [
      "#HttpOnly_.soundcloud.com",
      "TRUE",
      "/",
      "TRUE",
      String(expires),
      "oauth_token",
      token.data,
    ].join("\t"),
    "",
  ];
  // Owner-only where the OS supports it (on Windows the user's profile ACLs apply).
  await writeFile(file, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  return file;
}

/** Removes cookie files a crashed run may have left behind. Never rejects. */
export async function removeStaleCookieFiles(dataDir: string): Promise<void> {
  const dir = cookieDir(dataDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No tmp dir yet: nothing was ever written.
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(PREFIX))
      .map((name) => rm(path.join(dir, name), { force: true }).catch(() => undefined)),
  );
}
