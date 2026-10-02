import type { FetchLike } from "./types";

/**
 * Where the current api-v2 `client_id` is kept between requests. The id is not a user
 * credential, but it is never logged or written anywhere else.
 */
export interface ClientIdCache {
  get(): string | null;
  set(clientId: string | null): void;
}

export function createMemoryClientIdCache(): ClientIdCache {
  let current: string | null = null;
  return {
    get: () => current,
    set: (clientId) => {
      current = clientId;
    },
  };
}

export type ClientIdResult = { ok: true; clientId: string } | { ok: false; reason: string };

const SOUNDCLOUD_HOME = "https://soundcloud.com/";
const SCRIPT_SRC = /<script[^>]+src="(https:\/\/[^"]+\.js)"/g;
const CLIENT_ID = /\bclient_id\s*[:=]\s*"([A-Za-z0-9]{20,40})"/;
/** The id sits in one of the last app bundles; never fetch more than this many. */
const MAX_SCRIPTS = 12;

/** Only SoundCloud's own asset CDN, whatever the page happens to link to. */
function isSoundcloudAsset(src: string): boolean {
  if (!URL.canParse(src)) return false;
  const { protocol, hostname } = new URL(src);
  return protocol === "https:" && hostname.endsWith(".sndcdn.com");
}

/**
 * Finds the `client_id` the SoundCloud web app itself uses, by reading it out of the
 * scripts its home page loads. Never rejects.
 */
export async function discoverClientId(
  fetchFn: FetchLike,
  timeoutMs: number,
): Promise<ClientIdResult> {
  try {
    const home = await fetchFn(SOUNDCLOUD_HOME, { signal: AbortSignal.timeout(timeoutMs) });
    if (!home.ok) return { ok: false, reason: `soundcloud.com answered ${home.status}` };

    const html = await home.text();
    const scripts = [...html.matchAll(SCRIPT_SRC)]
      .map((match) => match[1])
      .filter((src): src is string => src !== undefined && isSoundcloudAsset(src))
      .reverse()
      .slice(0, MAX_SCRIPTS);
    if (scripts.length === 0) {
      return { ok: false, reason: "no app scripts found on soundcloud.com" };
    }

    for (const src of scripts) {
      const script = await fetchFn(src, { signal: AbortSignal.timeout(timeoutMs) });
      if (!script.ok) continue;
      const clientId = CLIENT_ID.exec(await script.text())?.[1];
      if (clientId !== undefined) return { ok: true, clientId };
    }
    return { ok: false, reason: "no client_id found in SoundCloud's app scripts" };
  } catch (error) {
    // Network failure or timeout: reported to the caller, which falls back to yt-dlp.
    return { ok: false, reason: `could not load soundcloud.com (${describeError(error)})` };
  }
}

/** An error's name and message, with any `client_id` query value removed. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/client_id=[^&\s"']+/g, "client_id=[redacted]").slice(0, 300);
}
