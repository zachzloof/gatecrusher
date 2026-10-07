import { describe, expect, it } from "vitest";
import { playlistSlug } from "@gatecrusher/core";
import { downloadsFolderSchema } from "./gate-state.ts";

describe("downloadsFolderSchema", () => {
  it("accepts the folder names playlistSlug makes", () => {
    for (const [url, title] of [
      ["https://soundcloud.com/dj/sets/peak-time-2026", "Peak Time"],
      ["not a url", "Ünïcødé Bangers!!"],
      ["https://soundcloud.com/dj/sets/", ""],
    ] as const) {
      expect(downloadsFolderSchema.safeParse(playlistSlug(url, title)).success).toBe(true);
    }
  });

  it.each(["", "..", ".", "../etc", "a/b", "a\b", "C:", "Mixed-Case", "-leading"])(
    "rejects %j",
    (name) => {
      expect(downloadsFolderSchema.safeParse(name).success).toBe(false);
    },
  );
});
