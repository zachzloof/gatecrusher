import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS, type WorkerEnv } from "@gatecrusher/core";
import { pino, type Logger } from "pino";

export function createLogger(level: WorkerEnv["LOG_LEVEL"]): Logger {
  return pino({
    level,
    base: { service: "worker" },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
  });
}
