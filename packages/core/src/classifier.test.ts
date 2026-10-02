import { describe, expect, it } from "vitest";
import { CLASSIFIER_CASES } from "./classifier.cases.ts";
import { classifyTrack, normalizeExternalUrl, storeNameForUrl } from "./classifier.ts";
import { TRACK_CLASSIFICATIONS } from "./domain.ts";

describe("classifyTrack", () => {
  it.each(CLASSIFIER_CASES)("$name", ({ input, expected }) => {
    expect(classifyTrack(input)).toEqual(expected);
  });

  it("is table-tested with at least 30 cases covering every classification", () => {
    expect(CLASSIFIER_CASES.length).toBeGreaterThanOrEqual(30);
    const covered = new Set(CLASSIFIER_CASES.map((testCase) => testCase.expected.classification));
    expect([...covered].sort()).toEqual([...TRACK_CLASSIFICATIONS].sort());
  });

  it("has uniquely named cases", () => {
    const names = CLASSIFIER_CASES.map((testCase) => testCase.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("only sets a gate platform for gates and a store for buys", () => {
    for (const { input } of CLASSIFIER_CASES) {
      const result = classifyTrack(input);
      expect(result.gatePlatform !== null).toBe(result.classification === "gate");
      expect(result.store !== null).toBe(result.classification === "buy");
    }
  });
});

describe("normalizeExternalUrl", () => {
  it.each([
    ["https://hypeddit.com/track/x", "https://hypeddit.com/track/x"],
    ["  http://click.dj/a  ", "http://click.dj/a"],
    ["hypeddit.com/track/x", "https://hypeddit.com/track/x"],
    ["//hypeddit.com/track/x", "https://hypeddit.com/track/x"],
    ["www.beatport.com", "https://www.beatport.com/"],
    ["example.com:8443/x", "https://example.com:8443/x"],
  ])("normalises %s", (raw, expected) => {
    expect(normalizeExternalUrl(raw)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "link in bio",
    "soon",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://files.example.com/x",
    "https://",
    "http://localhost/x",
    "http://127.0.0.1/x",
    "https://user:pass@example.com/x",
    `https://example.com/${"a".repeat(3000)}`,
  ])("rejects %s", (raw) => {
    expect(normalizeExternalUrl(raw)).toBeNull();
  });
});

describe("storeNameForUrl", () => {
  it.each([
    ["https://some-label.bandcamp.com/track/x", "Bandcamp"],
    ["https://www.beatport.com/track/x/1", "Beatport"],
    ["https://bit.ly/abc", "bit.ly"],
    ["www.some-shop.example.com/x", "some-shop.example.com"],
  ])("names %s", (url, expected) => {
    expect(storeNameForUrl(url)).toBe(expected);
  });

  it("is null without a usable link", () => {
    expect(storeNameForUrl(null)).toBeNull();
    expect(storeNameForUrl("javascript:alert(1)")).toBeNull();
  });

  it("agrees with the classifier on every buy case", () => {
    for (const { input, expected } of CLASSIFIER_CASES) {
      if (expected.classification === "buy") {
        expect(storeNameForUrl(input.purchaseUrl)).toBe(expected.store);
      }
    }
  });
});
