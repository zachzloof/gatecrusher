import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.ts";

describe("toCsv", () => {
  it("writes a header and CRLF-terminated rows", () => {
    expect(toCsv(["Store", "Title"], [["Bandcamp", "Some Track"]])).toBe(
      "Store,Title\r\nBandcamp,Some Track\r\n",
    );
  });

  it("writes only the header when there are no rows", () => {
    expect(toCsv(["Store", "Title"], [])).toBe("Store,Title\r\n");
  });

  it.each([
    ["a comma", "Artist, The", '"Artist, The"'],
    ["a double quote", 'The "Big" One', '"The ""Big"" One"'],
    ["a line break", "line one\nline two", '"line one\nline two"'],
    ["a carriage return", "line one\r\nline two", '"line one\r\nline two"'],
    ["leading whitespace", " padded", '" padded"'],
    ["trailing whitespace", "padded ", '"padded "'],
    ["plain unicode", "Çà et là – 夜", "Çà et là – 夜"],
  ])("escapes %s", (_label, value, expected) => {
    expect(toCsv(["h"], [[value]])).toBe(`h\r\n${expected}\r\n`);
  });

  it.each([
    ['=HYPERLINK("https://evil.example")', `"'=HYPERLINK(""https://evil.example"")"`],
    ["+1 (Original Mix)", "'+1 (Original Mix)"],
    ["-Intro-", "'-Intro-"],
    ["@artist", "'@artist"],
  ])("neutralises the formula %s", (value, expected) => {
    expect(toCsv(["h"], [[value]])).toBe(`h\r\n${expected}\r\n`);
  });

  it("writes numbers bare and empty cells for null, undefined and non-finite numbers", () => {
    expect(toCsv(["a", "b", "c", "d"], [[42, null, undefined, Number.NaN]])).toBe(
      "a,b,c,d\r\n42,,,\r\n",
    );
  });

  it("pads short rows and cuts long ones to the header width", () => {
    expect(toCsv(["a", "b"], [["1"], ["1", "2", "3"]])).toBe("a,b\r\n1,\r\n1,2\r\n");
  });
});
