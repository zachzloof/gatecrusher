const SENSITIVE_KEYS = [
  "password",
  "cookie",
  "authorization",
  "token",
  "oauthToken",
  "oauth_token",
  "apiKey",
] as const;

/**
 * pino `redact.paths` shared by every process: each sensitive key at the top level
 * and one or two levels deep (e.g. `headers.authorization`, `req.headers.cookie`).
 */
export const LOG_REDACT_PATHS: readonly string[] = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
]);

export const LOG_REDACT_CENSOR = "[redacted]";
