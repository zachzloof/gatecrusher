import { parseEnv, webEnvSchema, type EnvResult, type WebEnv } from "@gatecrusher/core";

/** Validates the web environment. The result never contains a value on failure. */
export function validateEnv(): EnvResult<WebEnv> {
  return parseEnv(webEnvSchema, process.env);
}

let cached: WebEnv | undefined;

/**
 * The validated environment. `instrumentation.ts` has already exited the process at
 * startup if it is invalid, so a throw here means that check was bypassed.
 */
export function getEnv(): WebEnv {
  if (cached === undefined) {
    const result = validateEnv();
    if (!result.ok) throw new Error(result.reason);
    cached = result.env;
  }
  return cached;
}
