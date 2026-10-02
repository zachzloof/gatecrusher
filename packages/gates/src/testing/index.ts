// Test support shared with the worker's integration tests. Never imported by app code.
import { fileURLToPath } from "node:url";
import { BIG_ENOUGH_BYTES, fakeHtmlPage, fakeMp3, fakeZip } from "./files.ts";
import type { FixtureFile } from "./fixture-server.ts";

export * from "./files.ts";
export * from "./fixture-server.ts";
export * from "./harness.ts";

/** The native SoundCloud adapter's fixture pages. */
export const NATIVE_FIXTURES_DIR = fileURLToPath(
  new URL("../native/__fixtures__", import.meta.url),
);

/** Pages the fixture server answers with a non-200 status. */
export const NATIVE_FIXTURE_STATUSES = { removed: 404 } as const;

/**
 * What the track fixture's "Download file" can deliver, picked with `?file=<key>`.
 * Every one claims to be an MP3: only the bytes say what it really is.
 */
export function nativeFixtureFiles(): Record<string, FixtureFile> {
  const claim = (body: Buffer, fileName: string): FixtureFile => ({
    body,
    contentType: "audio/mpeg",
    fileName,
  });
  return {
    audio: claim(fakeMp3(), "fixture-track.mp3"),
    tiny: claim(fakeMp3(2_048), "fixture-track.mp3"),
    html: claim(fakeHtmlPage(), "fixture-track.mp3"),
    "zip-audio": claim(
      fakeZip([
        { name: "cover.jpg", data: Buffer.from("not really a jpeg") },
        { name: "Fixture Artist - Fixture Track.mp3", data: fakeMp3() },
      ]),
      "fixture-pack.zip",
    ),
    "zip-no-audio": claim(
      fakeZip([{ name: "readme.txt", data: Buffer.alloc(BIG_ENOUGH_BYTES, 0x61) }]),
      "fixture-pack.zip",
    ),
  };
}
