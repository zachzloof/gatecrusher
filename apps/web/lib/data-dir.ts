import path from "node:path";
import { getEnv } from "./env";

/**
 * `DATA_DIR` as an absolute path. A relative value is relative to the repo root; Next
 * always runs with apps/web as the working directory. The Docker image sets an absolute
 * path instead.
 */
export function getDataDir(): string {
  return path.resolve(process.cwd(), "../..", getEnv().DATA_DIR);
}
