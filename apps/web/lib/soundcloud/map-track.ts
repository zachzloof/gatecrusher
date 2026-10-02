import { ingestedTrackSchema, normalizeExternalUrl, type IngestedTrack } from "@gatecrusher/core";
import type { ApiTrack, YtDlpEntry } from "./schemas";

const UNKNOWN_ARTIST = "Unknown artist";

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/** An image or permalink is only kept when it is a plain https URL. */
export function httpsUrl(value: string | null | undefined): string | null {
  const trimmed = nonEmpty(value);
  if (trimmed === null || !URL.canParse(trimmed)) return null;
  return new URL(trimmed).protocol === "https:" ? trimmed : null;
}

/** `null` when the track lacks something Gatecrusher cannot do without (title, link). */
export function trackFromApi(track: ApiTrack): IngestedTrack | null {
  const candidate = {
    soundcloudId: String(track.id),
    title: track.title.trim(),
    artist:
      nonEmpty(track.publisher_metadata?.artist) ??
      nonEmpty(track.user?.username) ??
      UNKNOWN_ARTIST,
    permalinkUrl: track.permalink_url,
    artworkUrl: httpsUrl(track.artwork_url) ?? httpsUrl(track.user?.avatar_url),
    durationMs:
      track.duration !== null && track.duration !== undefined && track.duration >= 0
        ? Math.round(track.duration)
        : null,
    purchaseUrl: normalizeExternalUrl(track.purchase_url),
    purchaseTitle: nonEmpty(track.purchase_title),
    downloadable: track.downloadable === true && track.has_downloads_left !== false,
  };
  const parsed = ingestedTrackSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** `/<artist>/<track>` of a SoundCloud track URL. */
function slugsOf(permalinkUrl: string | null): { artist: string | null; track: string | null } {
  if (permalinkUrl === null) return { artist: null, track: null };
  const [artist, track] = new URL(permalinkUrl).pathname.split("/").filter(Boolean);
  return { artist: artist ?? null, track: track ?? null };
}

/**
 * yt-dlp reports no purchase link or download flag, so those are always empty here and
 * the classifier can only answer `none` for these tracks.
 */
export function trackFromYtDlp(entry: YtDlpEntry): IngestedTrack | null {
  const permalinkUrl = httpsUrl(entry.webpage_url) ?? httpsUrl(entry.url);
  const slugs = slugsOf(permalinkUrl);
  const artwork = entry.thumbnails?.map((thumbnail) => httpsUrl(thumbnail.url)).findLast(Boolean);

  const candidate = {
    soundcloudId: entry.id,
    title: nonEmpty(entry.title) ?? slugs.track,
    artist: nonEmpty(entry.uploader) ?? slugs.artist ?? UNKNOWN_ARTIST,
    permalinkUrl,
    artworkUrl: artwork ?? null,
    durationMs:
      entry.duration !== null && entry.duration !== undefined && entry.duration >= 0
        ? Math.round(entry.duration * 1000)
        : null,
    purchaseUrl: null,
    purchaseTitle: null,
    downloadable: false,
  };
  const parsed = ingestedTrackSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
