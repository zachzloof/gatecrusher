import { validateGateAdapter } from "@gatecrusher/core";
import { describe, expect, it } from "vitest";
import { createNativeAdapter } from "./adapter.ts";

const adapter = createNativeAdapter();
const detect = (url: string) => adapter.detect(new URL(url));

describe("native adapter detect", () => {
  it.each([
    "https://soundcloud.com/fixture-artist/fixture-track",
    "https://www.soundcloud.com/fixture-artist/fixture-track",
    "https://m.soundcloud.com/fixture-artist/fixture-track",
    "https://SOUNDCLOUD.COM/Fixture-Artist/Fixture-Track",
    "https://soundcloud.com/fixture-artist/fixture-track/",
    "https://soundcloud.com/fixture-artist/fixture-track?si=abc&utm_source=clipboard",
    "https://soundcloud.com/fixture-artist/fixture-track/s-AbC123xyz",
    "https://soundcloud.com/fixture-artist/fixture-track#t=0:30",
  ])("matches %s", (url) => {
    expect(detect(url)).toBe(true);
  });

  it.each([
    ["a playlist", "https://soundcloud.com/fixture-artist/sets/fixture-crate"],
    ["a profile", "https://soundcloud.com/fixture-artist"],
    ["a profile's tracks tab", "https://soundcloud.com/fixture-artist/tracks"],
    ["a profile's likes", "https://soundcloud.com/fixture-artist/likes"],
    ["the home page", "https://soundcloud.com/"],
    ["a site page", "https://soundcloud.com/discover/sets"],
    ["the sign-in page", "https://soundcloud.com/signin/callback"],
    ["a deeper path", "https://soundcloud.com/a/b/c/d"],
    ["a third segment that is not a share token", "https://soundcloud.com/a/b/comments"],
    ["the api host", "https://api-v2.soundcloud.com/tracks/1"],
    ["a look-alike host", "https://soundcloud.com.evil.example/a/b"],
    ["a look-alike suffix", "https://notsoundcloud.com/a/b"],
    ["another site", "https://hypeddit.com/track/abc"],
    ["a non-web scheme", "ftp://soundcloud.com/a/b"],
  ])("does not match %s", (_label, url) => {
    expect(detect(url)).toBe(false);
  });

  it("can be pointed at other hosts for fixture tests", () => {
    const local = createNativeAdapter({ hosts: ["127.0.0.1"] });

    expect(local.detect(new URL("http://127.0.0.1:4000/fixture-artist/track"))).toBe(true);
    expect(local.detect(new URL("https://soundcloud.com/fixture-artist/track"))).toBe(false);
  });
});

describe("native adapter shape", () => {
  it("is a valid adapter that stays on SoundCloud", () => {
    expect(validateGateAdapter(adapter)).toEqual({ ok: true });
    expect(adapter.allowedHosts).toContain("soundcloud.com");
  });
});
