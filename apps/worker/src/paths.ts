import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** `DATA_DIR` as an absolute path. A relative value is relative to the repo root. */
export function resolveDataDir(dataDir: string): string {
  return path.resolve(REPO_ROOT, dataDir);
}

/** The persistent Chromium profile holding the burner login. Never read by app code. */
export function browserProfileDir(dataDir: string): string {
  return path.join(dataDir, "browser-profile");
}
