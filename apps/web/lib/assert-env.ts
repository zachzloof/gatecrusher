import { validateEnv } from "./env";

/** Exits the server with a readable message when the environment is invalid. */
export function assertEnv(): void {
  const result = validateEnv();
  if (!result.ok) {
    process.stderr.write(`\n${result.reason}\n\n`);
    process.exit(1);
  }
}
