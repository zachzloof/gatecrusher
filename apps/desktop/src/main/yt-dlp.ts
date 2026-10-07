// yt-dlp has to keep up with SoundCloud, which changes faster than this app is
// rebuilt. The app runs a copy of the yt-dlp it shipped with from the user's folder,
// where yt-dlp can update itself (`yt-dlp -U`) in the background on every start.
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MainLog } from "./log.ts";
import { executable } from "./paths.ts";

/** Written by scripts/fetch-binaries.mjs next to the shipped yt-dlp: its release tag. */
export const VERSION_FILE = "yt-dlp.version";

async function readVersion(file: string): Promise<string | null> {
  try {
    return (await readFile(file, "utf8")).trim() || null;
  } catch {
    // No marker: treated as "unknown, older than anything".
    return null;
  }
}

/** yt-dlp tags are dates (2026.09.30), so they compare as strings. */
export function isNewer(shipped: string | null, installed: string | null): boolean {
  // Without a shipped version there is nothing to compare: keep the copy.
  if (shipped === null) return false;
  return installed === null || shipped > installed;
}

/**
 * The yt-dlp to run. Copied from the shipped one when there is none yet, or when this
 * version of the app shipped a newer one than was last copied.
 */
export async function prepareYtDlp(options: {
  shippedBinDir: string;
  toolsDir: string;
  platform: NodeJS.Platform;
}): Promise<string> {
  const name = executable("yt-dlp", options.platform);
  const shipped = path.join(options.shippedBinDir, name);
  const target = path.join(options.toolsDir, name);
  const shippedVersion = await readVersion(path.join(options.shippedBinDir, VERSION_FILE));
  const copiedVersion = await readVersion(path.join(options.toolsDir, VERSION_FILE));

  let present = true;
  try {
    await access(target);
  } catch {
    // Never copied (first start), or removed: copy it now.
    present = false;
  }
  if (!present || isNewer(shippedVersion, copiedVersion)) {
    await mkdir(options.toolsDir, { recursive: true });
    await copyFile(shipped, target);
    if (options.platform !== "win32") await chmod(target, 0o755);
    await writeFile(path.join(options.toolsDir, VERSION_FILE), `${shippedVersion ?? ""}\n`);
  }
  return target;
}

/** Fire and forget: a failed update (offline, say) just leaves the current yt-dlp. */
export function updateYtDlpInBackground(ytDlp: string, log: MainLog): void {
  const output = log.stream("yt-dlp-update");
  const child = spawn(ytDlp, ["-U"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  child.once("error", (error) => log.warn("yt-dlp update could not run", { err: error }));
  child.once("exit", (code) => log.info("yt-dlp update finished", { code }));
}
