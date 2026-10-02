import type { TrackClassification } from "./domain.ts";

/** The SoundCloud metadata the classifier looks at. Anything may be missing. */
export interface ClassifierInput {
  purchaseUrl?: string | null;
  purchaseTitle?: string | null;
  downloadable?: boolean | null;
  /** SoundCloud caps native downloads per track; `false` means the cap is used up. */
  hasDownloadsLeft?: boolean | null;
}

export interface TrackClassificationResult {
  classification: TrackClassification;
  /** A platform id (`hypeddit`, `toneden`, ...) or `unknown`. Only set for `gate`. */
  gatePlatform: string | null;
  /** Display name of the store, or the bare hostname when it is not a known one. Only set for `buy`. */
  store: string | null;
}

/** Hosts that put a free download behind follow/like/repost steps. */
const GATE_HOSTS: Readonly<Record<string, string>> = {
  "hypeddit.com": "hypeddit",
  "toneden.io": "toneden",
  "theartistunion.com": "artistunion",
  "click.dj": "clickdj",
  "gate.fm": "gatefm",
  "pumpyoursound.com": "pumpyoursound",
  "stereoload.com": "stereoload",
  // File hosts: no social steps, but still a free download outside SoundCloud.
  "dropbox.com": "dropbox",
  "drive.google.com": "google-drive",
  "mediafire.com": "mediafire",
  "mega.nz": "mega",
  "wetransfer.com": "wetransfer",
  "we.tl": "wetransfer",
};

/** Hosts where the track is sold or only streamed. Never a free download. */
const STORE_HOSTS: Readonly<Record<string, string>> = {
  "bandcamp.com": "Bandcamp",
  "beatport.com": "Beatport",
  "traxsource.com": "Traxsource",
  "junodownload.com": "Juno Download",
  "juno.co.uk": "Juno",
  "itunes.apple.com": "Apple Music",
  "music.apple.com": "Apple Music",
  "amazon.com": "Amazon",
  "amazon.co.uk": "Amazon",
  "amazon.de": "Amazon",
  "spotify.com": "Spotify",
  "deezer.com": "Deezer",
  "tidal.com": "Tidal",
  "qobuz.com": "Qobuz",
  "bleep.com": "Bleep",
  "boomkat.com": "Boomkat",
};

const MAX_URL_LENGTH = 2048;

/** `host.tld:8080/x` starts like a scheme (`host.tld:`) but is a scheme-less URL. */
const HOST_WITH_PORT = /^[^/:@]+\.[^/:@]+:\d+(\/|$)/;

/**
 * A purchase link as an absolute http(s) URL, or `null` when it is missing or cannot be
 * one. SoundCloud lets uploaders type anything here, so a bare `hypeddit.com/track/x` is
 * given a scheme, and `javascript:` and friends are dropped.
 */
export function normalizeExternalUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LENGTH || /\s/.test(trimmed)) return null;

  let candidate: string;
  if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !HOST_WITH_PORT.test(trimmed)) {
    // Some other scheme: javascript:, ftp:, mailto:, ...
    return null;
  } else {
    candidate = `https://${trimmed.replace(/^\/\//, "")}`;
  }
  if (!URL.canParse(candidate)) return null;

  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  // A real public host has a dot and a non-numeric top-level label.
  if (!/^([a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) return null;
  return url.toString();
}

/** The value for `host` or the closest parent domain, so `x.bandcamp.com` finds `bandcamp.com`. */
function lookupHost(table: Readonly<Record<string, string>>, host: string): string | null {
  const labels = host.split(".");
  for (let start = 0; start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start).join(".");
    if (Object.hasOwn(table, candidate)) return table[candidate] ?? null;
  }
  return null;
}

function hostOf(normalizedUrl: string): string {
  return new URL(normalizedUrl).hostname.toLowerCase().replace(/^www\./, "");
}

const FREE_WORDS = /\bfree\b|gratis|gratuit|kostenlos/i;
const BUY_WORDS =
  /\bbuy\b|purchase|pre-?order|pre-?save|\bstream\b|out now|\bshop\b|vinyl|spotify|beatport|bandcamp|itunes|apple music/i;
const DOWNLOAD_WORDS = /download|\bdl\b|descarga/i;

/**
 * Whether the button text promises a free download. Only consulted when the host says
 * nothing: "Stream / Download" is a store link, "Free DL" and "Download" are not.
 */
function titleSaysFree(title: string | null | undefined): boolean {
  if (title === null || title === undefined) return false;
  if (FREE_WORDS.test(title)) return true;
  if (BUY_WORDS.test(title)) return false;
  return DOWNLOAD_WORDS.test(title);
}

/**
 * Decides how a track can be obtained. Pure: no network, so link shorteners and smart
 * links are judged by the button text alone.
 *
 * Order of precedence:
 * 1. SoundCloud's own download is enabled and has downloads left -> `native`.
 * 2. The link goes to a known gate or file host -> `gate`, whatever the button says.
 * 3. The link goes to a known store -> `buy`, whatever the button says.
 * 4. Any other valid link -> `gate` (`unknown`) if the button promises a free download,
 *    otherwise `buy` (SoundCloud's default button text is "Buy").
 * 5. No usable link -> `none`.
 */
export function classifyTrack(input: ClassifierInput): TrackClassificationResult {
  if (input.downloadable === true && input.hasDownloadsLeft !== false) {
    return { classification: "native", gatePlatform: null, store: null };
  }

  const link = normalizeExternalUrl(input.purchaseUrl);
  if (link === null) return { classification: "none", gatePlatform: null, store: null };

  const host = hostOf(link);

  const gatePlatform = lookupHost(GATE_HOSTS, host);
  if (gatePlatform !== null) return { classification: "gate", gatePlatform, store: null };

  const store = lookupHost(STORE_HOSTS, host);
  if (store !== null) return { classification: "buy", gatePlatform: null, store };

  if (titleSaysFree(input.purchaseTitle)) {
    return { classification: "gate", gatePlatform: "unknown", store: null };
  }
  return { classification: "buy", gatePlatform: null, store: host };
}

/**
 * What to call the place a buy link goes to: a known store's name, otherwise the bare
 * hostname. `null` when the link is not a usable URL.
 */
export function storeNameForUrl(purchaseUrl: string | null | undefined): string | null {
  const link = normalizeExternalUrl(purchaseUrl);
  if (link === null) return null;
  const host = hostOf(link);
  return lookupHost(STORE_HOSTS, host) ?? host;
}
