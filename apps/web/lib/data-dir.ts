import path from "node:path";
import { getEnv } from "./env";

/**
 * `DATA_DIR` as an absolute path. A relative value is relative to the repo root; Next
 * always runs with apps/web as the working directory. The Docker image sets an absolute
 * path instead.
 */
export function getDataDir(): string {
  // Resolved at run time; the comment keeps the build's file tracer from copying
  // whatever is under the repo (downloads included) into the server bundle.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../..", getEnv().DATA_DIR);
}
