import {
  LOG_REDACT_CENSOR,
  LOG_REDACT_PATHS,
  databaseEnvSchema,
  parseEnv,
  type DatabaseEnv,
} from "@gatecrusher/core";
import { pino, type Logger } from "pino";

/** Validates the environment for a db script, or exits with a readable message. */
export function loadCliEnv(script: string): { env: DatabaseEnv; log: Logger } {
  const result = parseEnv(databaseEnvSchema, process.env);
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }

  const log = pino({
    level: result.env.LOG_LEVEL,
    base: { service: "db", script },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
  });
  return { env: result.env, log };
}
