/** `5:07`, or `1:02:03` from an hour up. An em dash when the duration is unknown. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Shortens long text in the middle, keeping both ends readable: `hypeddit.com/tr…/abc123`. */
export function middleTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ""}`;
}

/** A link without its scheme and `www.`, for display. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
}

/** Only http(s) links are ever rendered as an `href`. */
export function safeHref(url: string | null): string | undefined {
  if (url === null || !URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url : undefined;
}
