import { z } from "zod";

/**
 * What a SoundCloud `oauth_token` cookie value looks like (`2-290123-123456789-AbCd…`).
 * URL-safe characters only, which is also what makes it safe to write into one line of
 * a cookie file as it is: no tab, newline or quote can get through.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/;

/**
 * Forgives the ways a value gets copied out of the browser's cookie table: surrounding
 * whitespace or quotes, or the whole `oauth_token=…` pair instead of just the value.
 */
export function normaliseSoundcloudToken(input: string): string {
  return input
    .trim()
    .replace(/^oauth_token\s*[=:]\s*/i, "")
    .replace(/^OAuth\s+/, "")
    .replace(/^["']|["';]$/g, "")
    .trim();
}

/**
 * A pasted SoundCloud login token. Pure shape check; nothing is fetched. The token is a
 * credential: never log it, echo it back, or put it in an error message.
 */
export const soundcloudTokenSchema = z
  .string()
  .max(4096)
  .transform(normaliseSoundcloudToken)
  .pipe(
    z.string().regex(TOKEN_PATTERN, {
      error:
        "That doesn't look like an oauth_token value. Copy the whole Value of the oauth_token cookie and paste it here.",
    }),
  );
