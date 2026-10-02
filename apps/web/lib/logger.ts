import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from "@gatecrusher/core";
import { pino, type Logger } from "pino";
import { getEnv } from "./env";

let logger: Logger | undefined;

export function getLogger(): Logger {
  logger ??= pino({
    level: getEnv().LOG_LEVEL,
    base: { service: "web" },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
  });
  return logger;
}
