import { z } from "zod";

const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]);

/** `/<user>/sets/<slug>` with an optional private-share token segment (`/s-…`). */
const PLAYLIST_PATH = /^\/[^/]+\/sets\/[^/]+(\/s-[A-Za-z0-9]+)?\/?$/;

function isSoundcloudPlaylistUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    SOUNDCLOUD_HOSTS.has(url.hostname) &&
    PLAYLIST_PATH.test(url.pathname)
  );
}

/** A public SoundCloud playlist ("set") URL. Pure shape check; nothing is fetched. */
export const soundcloudPlaylistUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(isSoundcloudPlaylistUrl, {
    error: "Enter a SoundCloud playlist URL, like https://soundcloud.com/artist/sets/name",
  });

/**
 * The one spelling of a playlist URL that is stored and resolved, so the same playlist
 * pasted from the mobile site, with a tracking query or a trailing slash is one row.
 * Expects a value that already passed `soundcloudPlaylistUrlSchema`.
 */
export function canonicalPlaylistUrl(validUrl: string): string {
  const url = new URL(validUrl);
  return `https://soundcloud.com${url.pathname.replace(/\/$/, "")}`;
}
