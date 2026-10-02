import type { IngestedTrack } from "@gatecrusher/core";
import { describeError } from "./client-id";
import { trackFromYtDlp } from "./map-track";
import type { ProcessRunner } from "./process-runner";
import { ytDlpEntrySchema, ytDlpPlaylistSchema } from "./schemas";
import type { SourceResult } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface YtDlpDeps {
  runner: ProcessRunner;
  /** Executable name or path, from `YT_DLP_PATH`. */
  command: string;
  timeoutMs?: number;
}

function unavailable(reason: string): SourceResult {
  return { ok: false, kind: "unavailable", reason: `yt-dlp: ${reason}` };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON: the schema below rejects `undefined`.
    return undefined;
  }
}

/**
 * Reads a playlist's metadata with `yt-dlp -J`. Metadata only: `--flat-playlist` lists
 * the tracks without resolving any audio, and nothing is downloaded. Never rejects.
 */
export async function fetchPlaylistFromYtDlp(
  deps: YtDlpDeps,
  playlistUrl: string,
): Promise<SourceResult> {
  // `--` ends the options, so the URL can never be read as one.
  const args = ["-J", "--flat-playlist", "--no-warnings", "--", playlistUrl];
  const result = await deps.runner.run(deps.command, args, {
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (!result.ok) {
    if (result.kind === "not_installed") {
      return unavailable("not installed (install it or set YT_DLP_PATH)");
    }
    if (result.kind === "failed" && /\b404\b|not found/i.test(result.detail)) {
      return {
        ok: false,
        kind: "not_found",
        reason: "SoundCloud has no public playlist at that URL. It may be private or deleted.",
      };
    }
    return unavailable(describeError(result.detail));
  }

  const parsed = ytDlpPlaylistSchema.safeParse(parseJson(result.stdout));
  if (!parsed.success) return unavailable("returned output in an unexpected shape");
  const { entries } = parsed.data;
  if (parsed.data._type !== "playlist" || entries === null || entries === undefined) {
    return { ok: false, kind: "not_a_playlist", reason: "That URL is not a SoundCloud playlist." };
  }

  const seen = new Set<string>();
  const tracks: IngestedTrack[] = [];
  let unavailableCount = 0;
  for (const raw of entries) {
    const entry = ytDlpEntrySchema.safeParse(raw);
    const track = entry.success ? trackFromYtDlp(entry.data) : null;
    if (track === null) {
      unavailableCount += 1;
    } else if (!seen.has(track.soundcloudId)) {
      seen.add(track.soundcloudId);
      tracks.push(track);
    }
  }

  return {
    ok: true,
    playlist: {
      source: "yt_dlp",
      soundcloudId: parsed.data.id ?? null,
      title: parsed.data.title?.trim() || "Untitled playlist",
      owner: parsed.data.uploader?.trim() || null,
      artworkUrl: tracks[0]?.artworkUrl ?? null,
      tracks,
      unavailableCount,
    },
  };
}
