import { describe, expect, it } from "vitest";
import {
  downloadBaseName,
  playlistSlug,
  sanitiseFileNamePart,
  withCollisionSuffix,
} from "./filenames.ts";

describe("sanitiseFileNamePart", () => {
  it.each([
    ["Plain Title", "Plain Title"],
    ["AC/DC", "AC DC"],
    ['What? "Quoted" <tags> | pipe * star: colon', "What Quoted tags pipe star colon"],
    ["back\\slash", "back slash"],
    ["../../etc/passwd", "etc passwd"],
    ["..", "untitled"],
    ["   ", "untitled"],
    ["", "untitled"],
    ["trailing dots...", "trailing dots"],
    [".hidden", "hidden"],
    ["tab\tand\nnewline", "tab and newline"],
    ["nul\u0000byte", "nul byte"],
    ["CON", "_CON"],
    ["nul.mp3", "_nul.mp3"],
    ["LPT1", "_LPT1"],
    ["Console", "Console"],
    ["Beyoncé — Déjà Vu (féat. 東京)", "Beyoncé — Déjà Vu (féat. 東京)"],
  ])("turns %j into %j", (input, expected) => {
    expect(sanitiseFileNamePart(input)).toBe(expected);
  });

  it("composes decomposed characters so one name has one spelling", () => {
    expect(sanitiseFileNamePart("e\u0301")).toBe("\u00e9");
  });

  it("limits the length without leaving a trailing space or dot", () => {
    expect(sanitiseFileNamePart("a".repeat(300))).toHaveLength(100);
    expect(sanitiseFileNamePart(`${"a".repeat(9)} bcd`, 10)).toBe("a".repeat(9));
    expect(sanitiseFileNamePart(`${"a".repeat(9)}.bcd`, 10)).toBe("a".repeat(9));
  });

  it("never returns a path separator or a parent segment", () => {
    for (const hostile of ["a/b", "a\\b", "..\\..\\x", "/abs", "C:\\x", "./x", "x/.."]) {
      const result = sanitiseFileNamePart(hostile);
      expect(result).not.toMatch(/[\\/:]/);
      expect(result).not.toBe("..");
    }
  });
});

describe("downloadBaseName", () => {
  it("joins artist and title", () => {
    expect(downloadBaseName("Fixture Artist", "Track (Original Mix)")).toBe(
      "Fixture Artist - Track (Original Mix)",
    );
  });

  it("sanitises both parts", () => {
    expect(downloadBaseName("A/B", "..")).toBe("A B - untitled");
  });
});

describe("withCollisionSuffix", () => {
  it("leaves the first name alone and numbers the rest", () => {
    expect(withCollisionSuffix("a - b", 1)).toBe("a - b");
    expect(withCollisionSuffix("a - b", 2)).toBe("a - b (2)");
    expect(withCollisionSuffix("a - b", 3)).toBe("a - b (3)");
  });
});

describe("playlistSlug", () => {
  it.each([
    ["https://soundcloud.com/curator/sets/fixture-crate", "Whatever", "fixture-crate"],
    ["https://soundcloud.com/curator/sets/Fixture_Crate/s-AbC123", "Whatever", "fixture-crate"],
    ["https://soundcloud.com/curator/sets/%2e%2e", "Summer Mix 2026!", "summer-mix-2026"],
    ["not a url", "Déjà Vu", "deja-vu"],
    ["https://soundcloud.com/curator/sets/", "   ", "playlist"],
    ["https://soundcloud.com/curator", "///", "playlist"],
  ])("%s (%s) -> %s", (url, title, expected) => {
    expect(playlistSlug(url, title)).toBe(expected);
  });

  it("is never longer than 80 characters and never a path", () => {
    const slug = playlistSlug(`https://soundcloud.com/c/sets/${"a-".repeat(100)}`, "t");
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
