import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1_000, "1 KB"],
    [940_000, "940 KB"],
    [9_400_000, "9.4 MB"],
    [1_234_567_890, "1.2 GB"],
    [-1, "—"],
    [Number.NaN, "—"],
  ])("%s -> %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});
import { displayUrl, formatDuration, middleTruncate, safeHref } from "./format";

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [7_000, "0:07"],
    [307_000, "5:07"],
    [307_499, "5:07"],
    [307_500, "5:08"],
    [3_599_600, "1:00:00"],
    [3_723_000, "1:02:03"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it.each([null, -1, Number.NaN])("shows a dash for %s", (value) => {
    expect(formatDuration(value)).toBe("—");
  });
});

describe("middleTruncate", () => {
  it("leaves short text alone", () => {
    expect(middleTruncate("hypeddit.com/x", 20)).toBe("hypeddit.com/x");
  });

  it("cuts the middle and keeps both ends", () => {
    const result = middleTruncate("hypeddit.com/track/a-very-long-slug-abc123", 21);

    expect(result).toBe("hypeddit.c…lug-abc123");
    expect(result).toHaveLength(21);
  });
});

describe("displayUrl", () => {
  it("drops the scheme, www and a trailing slash", () => {
    expect(displayUrl("https://www.beatport.com/track/x/1/")).toBe("beatport.com/track/x/1");
    expect(displayUrl("http://click.dj/a")).toBe("click.dj/a");
  });
});

describe("safeHref", () => {
  it("passes http(s) links through", () => {
    expect(safeHref("https://hypeddit.com/track/x")).toBe("https://hypeddit.com/track/x");
    expect(safeHref("http://click.dj/a")).toBe("http://click.dj/a");
  });

  it.each([null, "", "javascript:alert(1)", "data:text/html,x", "not a url"])(
    "refuses %s",
    (value) => {
      expect(safeHref(value)).toBeUndefined();
    },
  );
});
