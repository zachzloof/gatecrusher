import { describe, expect, it } from "vitest";
import { createFakeRunner, fixtureText } from "./testing";
import { fetchPlaylistFromYtDlp } from "./yt-dlp";

const PLAYLIST_URL = "https://soundcloud.com/fixture-curator/sets/fixture-crate";

describe("fetchPlaylistFromYtDlp", () => {
  it("invokes yt-dlp with an argument array, metadata only", async () => {
    const runner = createFakeRunner({ ok: true, stdout: fixtureText("yt-dlp-playlist.json") });

    await fetchPlaylistFromYtDlp({ runner, command: "C:\\tools\\yt-dlp.exe" }, PLAYLIST_URL);

    expect(runner.calls).toEqual([
      {
        command: "C:\\tools\\yt-dlp.exe",
        args: ["-J", "--flat-playlist", "--no-warnings", "--", PLAYLIST_URL],
      },
    ]);
  });

  it("maps the recorded output, skipping unreadable and duplicate entries", async () => {
    const runner = createFakeRunner({ ok: true, stdout: fixtureText("yt-dlp-playlist.json") });

    const result = await fetchPlaylistFromYtDlp({ runner, command: "yt-dlp" }, PLAYLIST_URL);

    if (!result.ok) throw new Error(result.reason);
    expect(result.playlist).toMatchObject({
      source: "yt_dlp",
      soundcloudId: "9001",
      title: "Fixture Crate",
      owner: "fixture-curator",
      unavailableCount: 1,
    });
    expect(result.playlist.tracks).toHaveLength(3);
    expect(result.playlist.tracks[0]).toEqual({
      soundcloudId: "101",
      title: "Native Download (Original Mix)",
      artist: "Fixture Artist",
      permalinkUrl: "https://soundcloud.com/fixture-artist/native-download",
      artworkUrl: "https://i1.sndcdn.com/artworks-fixture-101-t500x500.jpg",
      durationMs: 301_500,
      purchaseUrl: null,
      purchaseTitle: null,
      downloadable: false,
    });
    // A sparse entry: title and artist fall back to the URL's slugs.
    expect(result.playlist.tracks[2]).toMatchObject({
      soundcloudId: "103",
      title: "label-release",
      artist: "fixture-artist",
      artworkUrl: null,
      durationMs: null,
    });
  });

  it("answers unavailable when yt-dlp is not installed", async () => {
    const runner = createFakeRunner({ ok: false, kind: "not_installed", detail: "not found" });

    const result = await fetchPlaylistFromYtDlp({ runner, command: "yt-dlp" }, PLAYLIST_URL);

    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      reason: "yt-dlp: not installed (install it or set YT_DLP_PATH)",
    });
  });

  it("answers not_found when yt-dlp reports a 404", async () => {
    const runner = createFakeRunner({
      ok: false,
      kind: "failed",
      detail: "ERROR: [soundcloud:set] Unable to download JSON metadata: HTTP Error 404: Not Found",
    });

    const result = await fetchPlaylistFromYtDlp({ runner, command: "yt-dlp" }, PLAYLIST_URL);

    expect(result).toMatchObject({ ok: false, kind: "not_found" });
  });

  it.each([
    ["a timeout", { ok: false, kind: "timeout", detail: "timed out after 120000ms" }],
    ["another failure", { ok: false, kind: "failed", detail: "ERROR: something else broke" }],
    ["output that is not JSON", { ok: true, stdout: "WARNING: nope" }],
    ["JSON in an unexpected shape", { ok: true, stdout: '{"entries":"nope"}' }],
  ] as const)("answers unavailable on %s", async (_label, outcome) => {
    const result = await fetchPlaylistFromYtDlp(
      { runner: createFakeRunner(outcome), command: "yt-dlp" },
      PLAYLIST_URL,
    );

    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("removes a client_id from a failure before reporting it", async () => {
    const runner = createFakeRunner({
      ok: false,
      kind: "failed",
      detail: "ERROR: bad gateway for https://api-v2.soundcloud.com/x?client_id=abc123DEF&y=1",
    });

    const result = await fetchPlaylistFromYtDlp({ runner, command: "yt-dlp" }, PLAYLIST_URL);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("abc123DEF");
  });

  it("answers not_a_playlist when the output describes a single track", async () => {
    const runner = createFakeRunner({
      ok: true,
      stdout: JSON.stringify({ _type: "video", id: "101", title: "One Track" }),
    });

    const result = await fetchPlaylistFromYtDlp({ runner, command: "yt-dlp" }, PLAYLIST_URL);

    expect(result).toMatchObject({ ok: false, kind: "not_a_playlist" });
  });
});
