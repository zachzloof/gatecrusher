import { describe, expect, it } from "vitest";
import { canonicalPlaylistUrl, soundcloudPlaylistUrlSchema } from "./soundcloud-url.ts";

describe("soundcloudPlaylistUrlSchema", () => {
  it.each([
    "https://soundcloud.com/some-artist/sets/summer-digs",
    "https://www.soundcloud.com/some-artist/sets/summer-digs/",
    "https://m.soundcloud.com/some-artist/sets/summer-digs",
    "https://SoundCloud.com/some-artist/sets/summer-digs?si=abc123",
    "https://soundcloud.com/some-artist/sets/private-set/s-AbC123xyz",
    "  https://soundcloud.com/some-artist/sets/padded  ",
  ])("accepts %s", (url) => {
    expect(soundcloudPlaylistUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    "",
    "not a url",
    "soundcloud.com/some-artist/sets/no-protocol",
    "http://soundcloud.com/some-artist/sets/plain-http",
    "ftp://soundcloud.com/some-artist/sets/x",
    "https://soundcloud.com/some-artist/a-single-track",
    "https://soundcloud.com/some-artist/sets",
    "https://soundcloud.com/some-artist/sets/a/b/c",
    "https://soundcloud.com.evil.example/some-artist/sets/x",
    "https://evil.example/soundcloud.com/a/sets/x",
    "https://user:pass@soundcloud.com/some-artist/sets/x",
    "https://soundcloud.com:8443/some-artist/sets/x",
    "https://localhost/some-artist/sets/x",
    "javascript:alert(1)",
  ])("rejects %s", (url) => {
    expect(soundcloudPlaylistUrlSchema.safeParse(url).success).toBe(false);
  });

  it.each([
    ["https://m.soundcloud.com/some-artist/sets/summer-digs", "/some-artist/sets/summer-digs"],
    ["https://www.soundcloud.com/some-artist/sets/summer-digs/", "/some-artist/sets/summer-digs"],
    [
      "https://SoundCloud.com/some-artist/sets/summer-digs?si=abc123&utm_source=x#t=1",
      "/some-artist/sets/summer-digs",
    ],
    [
      "https://soundcloud.com/some-artist/sets/private-set/s-AbC123xyz",
      "/some-artist/sets/private-set/s-AbC123xyz",
    ],
  ])("canonicalises %s", (input, path) => {
    expect(canonicalPlaylistUrl(soundcloudPlaylistUrlSchema.parse(input))).toBe(
      `https://soundcloud.com${path}`,
    );
  });

  it("trims the accepted value", () => {
    expect(soundcloudPlaylistUrlSchema.parse(" https://soundcloud.com/a/sets/b ")).toBe(
      "https://soundcloud.com/a/sets/b",
    );
  });
});
