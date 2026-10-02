import type { ClassifierInput, TrackClassificationResult } from "./classifier.ts";

export interface ClassifierCase {
  name: string;
  input: ClassifierInput;
  expected: TrackClassificationResult;
}

const native: TrackClassificationResult = {
  classification: "native",
  gatePlatform: null,
  store: null,
};
const none: TrackClassificationResult = { classification: "none", gatePlatform: null, store: null };
const gate = (gatePlatform: string): TrackClassificationResult => ({
  classification: "gate",
  gatePlatform,
  store: null,
});
const buy = (store: string): TrackClassificationResult => ({
  classification: "buy",
  gatePlatform: null,
  store,
});

/**
 * Shapes seen on real SoundCloud tracks, with invented slugs. Add a case here whenever a
 * track turns up classified wrongly.
 */
export const CLASSIFIER_CASES: readonly ClassifierCase[] = [
  // --- native ---------------------------------------------------------------------
  { name: "downloadable, no purchase link", input: { downloadable: true }, expected: native },
  {
    name: "downloadable with downloads left",
    input: { downloadable: true, hasDownloadsLeft: true },
    expected: native,
  },
  {
    name: "downloadable + purchase_url to a gate: native wins, no gate needed",
    input: {
      downloadable: true,
      purchaseUrl: "https://hypeddit.com/track/abc123",
      purchaseTitle: "Free Download",
    },
    expected: native,
  },
  {
    name: "downloadable + purchase_url to a store: native wins",
    input: {
      downloadable: true,
      purchaseUrl: "https://www.beatport.com/track/some-track/123",
      purchaseTitle: "Buy",
    },
    expected: native,
  },
  {
    name: "downloadable but the download cap is used up, gate link present",
    input: {
      downloadable: true,
      hasDownloadsLeft: false,
      purchaseUrl: "https://hypeddit.com/track/abc123",
    },
    expected: gate("hypeddit"),
  },
  {
    name: "downloadable but the download cap is used up, no link",
    input: { downloadable: true, hasDownloadsLeft: false },
    expected: none,
  },

  // --- known gates ----------------------------------------------------------------
  {
    name: "hypeddit with a free-download title",
    input: { purchaseUrl: "https://hypeddit.com/track/abc123", purchaseTitle: "Free Download" },
    expected: gate("hypeddit"),
  },
  {
    name: "hypeddit with www and no title",
    input: { purchaseUrl: "https://www.hypeddit.com/artist/some-track" },
    expected: gate("hypeddit"),
  },
  {
    name: "buy title pointing at a gate",
    input: { purchaseUrl: "https://hypeddit.com/track/abc123", purchaseTitle: "Buy" },
    expected: gate("hypeddit"),
  },
  {
    name: "toneden",
    input: { purchaseUrl: "https://www.toneden.io/some-artist/post/some-track" },
    expected: gate("toneden"),
  },
  {
    name: "the artist union",
    input: { purchaseUrl: "https://theartistunion.com/tracks/a1b2c3", purchaseTitle: "FREE DL" },
    expected: gate("artistunion"),
  },
  {
    name: "click.dj",
    input: { purchaseUrl: "http://click.dj/some-label/some-track" },
    expected: gate("clickdj"),
  },
  {
    name: "pumpyoursound, upper-case host",
    input: { purchaseUrl: "HTTPS://PumpYourSound.com/fangate/detail/123-x" },
    expected: gate("pumpyoursound"),
  },
  {
    name: "dropbox file link",
    input: { purchaseUrl: "https://www.dropbox.com/s/abc/track.wav?dl=0", purchaseTitle: "DL" },
    expected: gate("dropbox"),
  },
  {
    name: "google drive file link",
    input: { purchaseUrl: "https://drive.google.com/file/d/abc/view" },
    expected: gate("google-drive"),
  },
  {
    name: "gate host with no scheme typed",
    input: { purchaseUrl: "hypeddit.com/track/abc123", purchaseTitle: "Free Download" },
    expected: gate("hypeddit"),
  },
  {
    name: "gate host with surrounding whitespace",
    input: { purchaseUrl: "  https://hypeddit.com/track/abc123\n" },
    expected: gate("hypeddit"),
  },

  // --- known stores ---------------------------------------------------------------
  {
    name: "bandcamp subdomain",
    input: { purchaseUrl: "https://some-label.bandcamp.com/track/some-track" },
    expected: buy("Bandcamp"),
  },
  {
    name: '"Free Download" title pointing at a store',
    input: {
      purchaseUrl: "https://some-label.bandcamp.com/track/some-track",
      purchaseTitle: "Free Download",
    },
    expected: buy("Bandcamp"),
  },
  {
    name: "beatport",
    input: { purchaseUrl: "https://www.beatport.com/release/some-ep/456", purchaseTitle: "Buy" },
    expected: buy("Beatport"),
  },
  {
    name: "traxsource",
    input: { purchaseUrl: "https://www.traxsource.com/title/789/some-ep" },
    expected: buy("Traxsource"),
  },
  {
    name: "apple music",
    input: { purchaseUrl: "https://music.apple.com/gb/album/some-ep/123" },
    expected: buy("Apple Music"),
  },
  {
    name: "spotify stream link",
    input: { purchaseUrl: "https://open.spotify.com/track/abc", purchaseTitle: "Stream" },
    expected: buy("Spotify"),
  },

  // --- unknown hosts, shorteners and smart links: the title decides -----------------
  {
    name: "shortener with a free-download title",
    input: { purchaseUrl: "https://bit.ly/3abcDEF", purchaseTitle: "Free Download" },
    expected: gate("unknown"),
  },
  {
    name: "shortener with a buy title",
    input: { purchaseUrl: "https://bit.ly/3abcDEF", purchaseTitle: "Buy on Beatport" },
    expected: buy("bit.ly"),
  },
  {
    name: "shortener with no title defaults to buy",
    input: { purchaseUrl: "https://tinyurl.com/abc123" },
    expected: buy("tinyurl.com"),
  },
  {
    name: "smart link with a stream/download title is a store chooser",
    input: {
      purchaseUrl: "https://some-label.lnk.to/some-track",
      purchaseTitle: "Stream / Download",
    },
    expected: buy("some-label.lnk.to"),
  },
  {
    name: "smart link promising a free download",
    input: { purchaseUrl: "https://fanlink.to/some-track", purchaseTitle: "FREE DL" },
    expected: gate("unknown"),
  },
  {
    name: "unknown host with a plain Download title",
    input: { purchaseUrl: "https://some-artist.example.com/dl/track", purchaseTitle: "Download" },
    expected: gate("unknown"),
  },
  {
    name: "unknown host with a free title in another language",
    input: { purchaseUrl: "https://example.org/descarga", purchaseTitle: "Descarga gratis" },
    expected: gate("unknown"),
  },
  {
    name: "unknown host with an empty title",
    input: { purchaseUrl: "https://some-artist.example.com/", purchaseTitle: "" },
    expected: buy("some-artist.example.com"),
  },
  {
    name: '"freedom" in the title is not "free"',
    input: { purchaseUrl: "https://example.org/x", purchaseTitle: "Freedom EP out now" },
    expected: buy("example.org"),
  },
  {
    name: "a host that merely ends with a gate's name",
    input: { purchaseUrl: "https://nothypeddit.com/track/x" },
    expected: buy("nothypeddit.com"),
  },
  {
    name: "a gate's name used as a subdomain of another host",
    input: { purchaseUrl: "https://hypeddit.com.example.net/track/x" },
    expected: buy("hypeddit.com.example.net"),
  },

  // --- missing, empty and malformed links --------------------------------------------
  { name: "nothing set", input: {}, expected: none },
  {
    name: "explicit nulls",
    input: { purchaseUrl: null, purchaseTitle: null, downloadable: null },
    expected: none,
  },
  {
    name: "not downloadable, no link",
    input: { downloadable: false, purchaseUrl: null },
    expected: none,
  },
  { name: "empty link", input: { purchaseUrl: "" }, expected: none },
  { name: "whitespace link", input: { purchaseUrl: "   " }, expected: none },
  {
    name: "free title but no link: nowhere to go",
    input: { purchaseTitle: "Free Download" },
    expected: none,
  },
  { name: "words instead of a link", input: { purchaseUrl: "link in bio" }, expected: none },
  { name: "a single word", input: { purchaseUrl: "soon" }, expected: none },
  { name: "javascript: link", input: { purchaseUrl: "javascript:alert(1)" }, expected: none },
  { name: "ftp link", input: { purchaseUrl: "ftp://files.example.com/track.mp3" }, expected: none },
  { name: "mailto link", input: { purchaseUrl: "mailto:artist@example.com" }, expected: none },
  { name: "scheme with no host", input: { purchaseUrl: "https://" }, expected: none },
  { name: "localhost", input: { purchaseUrl: "http://localhost:3000/x" }, expected: none },
  { name: "IP address", input: { purchaseUrl: "http://192.168.1.10/track" }, expected: none },
  {
    name: "link with embedded credentials",
    input: { purchaseUrl: "https://user:pass@hypeddit.com/track/x" },
    expected: none,
  },
];
