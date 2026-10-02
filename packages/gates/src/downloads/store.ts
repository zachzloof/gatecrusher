import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  downloadBaseName,
  sanitiseFileNamePart,
  withCollisionSuffix,
  type DownloadAttempt,
} from "@gatecrusher/core";
import type { Download } from "playwright";
import { verifyDownload } from "./verify.ts";

export const DOWNLOADS_DIRECTORY = "downloads";

export interface DownloadTarget {
  /** Directory under `downloads/`. Sanitised again here; it is never trusted as a path. */
  playlistSlug: string;
  artist: string;
  title: string;
}

export interface DownloadStoreOptions {
  /** Absolute path of the data dir. */
  dataDir: string;
  minBytes: number;
  target: DownloadTarget;
}

/** Stores what a browser download delivered, or says why it does not count. */
export type DownloadCapture = (download: Download) => Promise<DownloadAttempt>;

const MAX_NAME_ATTEMPTS = 1_000;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    // access() rejects exactly when the path is not there (or not reachable): free name.
    return false;
  }
}

/** Browser jobs run one at a time, so check-then-rename cannot race with another job. */
async function freePath(directory: string, baseName: string, extension: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(
      directory,
      `${withCollisionSuffix(baseName, attempt)}.${extension}`,
    );
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No free file name for "${baseName}" after ${MAX_NAME_ATTEMPTS} attempts`);
}

/**
 * Saves a download as `downloads/<playlist-slug>/<artist> - <title>.<ext>` — but only
 * once it has passed verification. Until then it lives under a temporary name, which is
 * removed on every failure path, so a partial or bogus file is never left behind.
 */
export function createDownloadCapture(options: DownloadStoreOptions): DownloadCapture {
  const root = path.resolve(options.dataDir, DOWNLOADS_DIRECTORY);
  const directory = path.join(root, sanitiseFileNamePart(options.target.playlistSlug));
  // The slug is sanitised, so this can only fail if that guarantee is ever broken.
  if (path.dirname(directory) !== root) {
    throw new Error("Download directory escaped the downloads root");
  }

  return async (download) => {
    await mkdir(directory, { recursive: true });
    const partial = path.join(directory, `.partial-${randomUUID()}`);
    try {
      try {
        await download.saveAs(partial);
      } catch (error) {
        const failure = await download.failure();
        if (failure === null) throw error;
        return {
          ok: false,
          kind: "no_download",
          reason: `the download was interrupted (${failure})`,
        };
      }

      const verdict = await verifyDownload(partial, { minBytes: options.minBytes });
      if (!verdict.ok) return { ok: false, kind: "verification_failed", reason: verdict.reason };

      const baseName = downloadBaseName(options.target.artist, options.target.title);
      const finalPath = await freePath(directory, baseName, verdict.extension);
      await rename(partial, finalPath);
      return {
        ok: true,
        download: {
          path: path.relative(path.resolve(options.dataDir), finalPath).split(path.sep).join("/"),
          sizeBytes: verdict.sizeBytes,
          mimeType: verdict.mimeType,
          kind: verdict.kind,
          checksumSha256: verdict.checksumSha256,
        },
      };
    } finally {
      // A no-op after a successful rename; otherwise this is the partial-file cleanup.
      await rm(partial, { force: true });
      // Playwright keeps its own temporary copy until the context closes.
      await download.delete();
    }
  };
}
