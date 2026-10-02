import { parseEnv, workerEnvSchema, type WorkerEnv } from "@gatecrusher/core";

/** Validates the worker's environment, or exits with a message naming what is wrong. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = parseEnv(workerEnvSchema, source);
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
  return result.env;
}
