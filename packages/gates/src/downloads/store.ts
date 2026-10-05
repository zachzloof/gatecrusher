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

export interface FileStore {
  /** The directory the files of this target go in. */
  directory: string;
  /** A fresh temporary path inside `directory` to write a download to. */
  partialPath(): string;
  /**
   * Verifies the file at `partial` and moves it into place, or removes it and says why
   * it does not count. The partial file is gone either way.
   */
  keep(partial: string): Promise<DownloadAttempt>;
}

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
 * Files for one track, saved as `downloads/<playlist-slug>/<artist> - <title>.<ext>` —
 * but only once they have passed verification. Until then a file lives under a
 * temporary name, which is removed on every failure path, so a partial or bogus file is
 * never left behind.
 */
export function createFileStore(options: DownloadStoreOptions): FileStore {
  const root = path.resolve(options.dataDir, DOWNLOADS_DIRECTORY);
  const directory = path.join(root, sanitiseFileNamePart(options.target.playlistSlug));
  // The slug is sanitised, so this can only fail if that guarantee is ever broken.
  if (path.dirname(directory) !== root) {
    throw new Error("Download directory escaped the downloads root");
  }

  return {
    directory,
    partialPath: () => path.join(directory, `.partial-${randomUUID()}`),
    keep: async (partial) => {
      try {
        const verdict = await verifyDownload(partial, { minBytes: options.minBytes });
        if (!verdict.ok) {
          return { ok: false, kind: "verification_failed", reason: verdict.reason };
        }

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
      }
    },
  };
}

/** Saves what a browser download delivered through the file store. */
export function createDownloadCapture(options: DownloadStoreOptions): DownloadCapture {
  const store = createFileStore(options);

  return async (download) => {
    await mkdir(store.directory, { recursive: true });
    const partial = store.partialPath();
    try {
      try {
        await download.saveAs(partial);
      } catch (error) {
        const failure = await download.failure();
        if (failure === null) throw error;
        await rm(partial, { force: true });
        return {
          ok: false,
          kind: "no_download",
          reason: `the download was interrupted (${failure})`,
        };
      }
      return await store.keep(partial);
    } finally {
      // Playwright keeps its own temporary copy until the context closes.
      await download.delete();
    }
  };
}
