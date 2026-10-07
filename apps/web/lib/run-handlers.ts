// The logic behind the run and screenshot routes, with everything they touch passed in,
// so tests can run them against a throwaway database and a temp data dir.
import { createReadStream } from "node:fs";
import { readFile, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { playlistSlug } from "@gatecrusher/core";
import {
  cancelPlaylistRun,
  deletePlaylist,
  getSoundcloudAccount,
  isRecordedScreenshot,
  listPlaylistDownloads,
  startPlaylistRun,
  type Database,
} from "@gatecrusher/db";
import { z } from "zod";
import {
  cancelRunResponseSchema,
  deletePlaylistResponseSchema,
  runResponseSchema,
} from "./api-schemas";
import {
  errorResponse,
  guarded,
  NO_STORE,
  READ_TIMEOUT_MS,
  type HandlerLog,
} from "./handler-utils";
import { recordedPathFromSegments } from "./screenshots";
import { withTimeout } from "./with-timeout";
import { createZipStream, uniqueEntryNames } from "./zip-stream";

export interface RunHandlerDeps {
  db: Database;
  /** Absolute path of the data dir. */
  dataDir: string;
  log: HandlerLog;
}

export const NOT_CONNECTED_MESSAGE =
  "Connect a SoundCloud account first: SoundCloud only hands an uploader's file or its best stream to a signed-in account.";

/**
 * POST /api/playlists/:id/runs — "Download tracks".
 *
 * Queues every track that has no verified download yet, one at a time for the
 * worker, and sends paused tracks back for another look. Safe to click repeatedly.
 * The queue is the jobs table: the worker picks QUEUED jobs up by itself.
 */
export function handleStartRun(playlistId: string, deps: RunHandlerDeps): Promise<Response> {
  return guarded(deps.log, "POST /api/playlists/:id/runs", async () => {
    const id = z.uuid().safeParse(playlistId);
    if (!id.success) return errorResponse(404, "not_found", "No such playlist.");

    // Without a login every download would fail, so nothing is queued at all.
    if ((await withTimeout(getSoundcloudAccount(deps.db), READ_TIMEOUT_MS)) === null) {
      return errorResponse(409, "soundcloud_not_connected", NOT_CONNECTED_MESSAGE);
    }

    const started = await withTimeout(startPlaylistRun(deps.db, id.data), READ_TIMEOUT_MS);
    if (!started.ok) return errorResponse(404, "not_found", started.reason);

    return Response.json(
      runResponseSchema.parse({
        runId: started.runId,
        queued: started.newJobIds.length,
        resumed: started.resumedJobIds.length,
        alreadyDownloaded: started.alreadyDownloaded,
        alreadyActive: started.queuedJobIds.length + started.alreadyRunning,
      }),
      { status: 202, headers: NO_STORE },
    );
  });
}

/**
 * DELETE /api/playlists/:id/runs — "Cancel".
 *
 * Cancels every queued track of the playlist. A track already downloading finishes;
 * nothing starts after it. Clicking "Download tracks" queues the cancelled ones again.
 */
export function handleCancelRun(playlistId: string, deps: RunHandlerDeps): Promise<Response> {
  return guarded(deps.log, "DELETE /api/playlists/:id/runs", async () => {
    const id = z.uuid().safeParse(playlistId);
    if (!id.success) return errorResponse(404, "not_found", "No such playlist.");

    const cancelled = await withTimeout(cancelPlaylistRun(deps.db, id.data), READ_TIMEOUT_MS);
    if (!cancelled.ok) return errorResponse(404, "not_found", cancelled.reason);

    return Response.json(
      cancelRunResponseSchema.parse({ cancelled: cancelled.cancelled, running: cancelled.running }),
      { headers: NO_STORE },
    );
  });
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/**
 * Deletes recorded download files, then the folders they leave empty. Only paths inside
 * the data dir's downloads folder are ever touched. Returns what was removed.
 */
async function removeDownloadFiles(
  filePaths: readonly string[],
  deps: RunHandlerDeps,
): Promise<{ deletedFiles: number; freedBytes: number }> {
  const root = path.resolve(deps.dataDir, "downloads");
  const folders = new Set<string>();
  let deletedFiles = 0;
  let freedBytes = 0;

  for (const filePath of filePaths) {
    const file = path.resolve(deps.dataDir, filePath);
    if (!file.startsWith(root + path.sep)) {
      // A recorded path outside the downloads folder means the database was tampered with.
      deps.log.error({ filePath }, "Refusing to delete a download outside the downloads folder");
      continue;
    }
    try {
      const { size } = await stat(file);
      await rm(file);
      deletedFiles += 1;
      freedBytes += size;
    } catch (error) {
      // Already gone (removed by hand): nothing to free.
      if (errorCode(error) !== "ENOENT") throw error;
    }
    folders.add(path.dirname(file));
  }

  for (const folder of folders) {
    if (folder === root) continue;
    try {
      await rmdir(folder);
    } catch (error) {
      // Removed only when empty: files the app did not record stay where they are.
      const code = errorCode(error);
      if (code !== "ENOTEMPTY" && code !== "ENOENT" && code !== "EEXIST") {
        deps.log.error({ err: error, folder }, "Could not remove an empty download folder");
      }
    }
  }
  return { deletedFiles, freedBytes };
}

/**
 * DELETE /api/playlists/:id — the playlist, everything recorded about it, and its
 * downloaded files. Refused while one of its tracks is downloading.
 */
export function handleDeletePlaylist(playlistId: string, deps: RunHandlerDeps): Promise<Response> {
  return guarded(deps.log, "DELETE /api/playlists/:id", async () => {
    const id = z.uuid().safeParse(playlistId);
    if (!id.success) return errorResponse(404, "not_found", "No such playlist.");

    const deleted = await withTimeout(deletePlaylist(deps.db, id.data), READ_TIMEOUT_MS);
    if (!deleted.ok) {
      return deleted.kind === "busy"
        ? errorResponse(409, "playlist_busy", deleted.reason)
        : errorResponse(404, "not_found", deleted.reason);
    }

    const removed = await removeDownloadFiles(deleted.filePaths, deps);
    return Response.json(deletePlaylistResponseSchema.parse(removed), { headers: NO_STORE });
  });
}

const notFound = (): Response => errorResponse(404, "not_found", "No such screenshot.");

/**
 * GET /api/screenshots/:runId/:jobId/:file — a screenshot a job recorded.
 *
 * Serves only paths that have the screenshot shape, are recorded in the database, and
 * resolve inside the data dir's screenshots folder. Anything else is a 404.
 */
export function handleScreenshot(
  segments: readonly string[],
  deps: RunHandlerDeps,
): Promise<Response> {
  return guarded(deps.log, "GET /api/screenshots/*", async () => {
    const recordedPath = recordedPathFromSegments(segments);
    if (recordedPath === null) return notFound();
    if (!(await withTimeout(isRecordedScreenshot(deps.db, recordedPath), READ_TIMEOUT_MS))) {
      return notFound();
    }

    const root = path.resolve(deps.dataDir, "screenshots");
    const file = path.resolve(deps.dataDir, recordedPath);
    // Cannot happen for a path that passed the shape check; kept as the last line of defence.
    if (!file.startsWith(root + path.sep)) return notFound();

    let image: Buffer;
    try {
      image = await readFile(file);
    } catch (error) {
      // Recorded but no longer on disk (the data dir was cleaned up).
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return notFound();
      throw error;
    }
    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(image.length),
        // A recorded screenshot never changes; it is private to this machine's user.
        "Cache-Control": "private, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

/** A file name the Content-Disposition header can carry on every browser. */
function asciiFileName(name: string): string {
  const ascii = name
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "_")
    .trim();
  return ascii === "" ? "playlist" : ascii;
}

/** The `tracks` field of the archive route: which tracks to include, ids separated by commas. */
const archiveTracksSchema = z.array(z.uuid()).min(1).max(5_000);

/**
 * GET and POST /api/playlists/:id/archive — the verified downloads of a playlist as one
 * zip, streamed straight from the files on disk. `tracks` (a POST form field, ids
 * separated by commas) limits the zip to those tracks; without it, every file goes in.
 * Only paths recorded in `downloads` that resolve inside the data dir's downloads
 * folder are ever read.
 */
export function handleArchive(
  playlistId: string,
  deps: RunHandlerDeps,
  tracksField: string | null = null,
): Promise<Response> {
  return guarded(deps.log, "GET /api/playlists/:id/archive", async () => {
    const id = z.uuid().safeParse(playlistId);
    if (!id.success) return errorResponse(404, "not_found", "No such playlist.");
    const ids = tracksField === null ? null : archiveTracksSchema.safeParse(tracksField.split(","));
    if (ids !== null && !ids.success) {
      return errorResponse(400, "invalid_request", "tracks must be track ids separated by commas.");
    }
    const only = ids === null ? null : new Set(ids.data);

    const found = await withTimeout(listPlaylistDownloads(deps.db, id.data), READ_TIMEOUT_MS);
    if (found === null) return errorResponse(404, "not_found", "No such playlist.");
    const files =
      only === null ? found.files : found.files.filter((file) => only.has(file.trackId));
    if (files.length === 0) {
      return errorResponse(
        404,
        "not_found",
        only === null
          ? "Nothing has been downloaded for this playlist yet."
          : "None of the ticked tracks has been downloaded yet.",
      );
    }

    const root = path.resolve(deps.dataDir, "downloads");
    const paths = files.map((file) => path.resolve(deps.dataDir, file.filePath));
    if (paths.some((file) => !file.startsWith(root + path.sep))) {
      // A recorded path outside the downloads folder means the database was tampered
      // with; nothing is served from it.
      throw new Error("A recorded download path is outside the downloads folder");
    }
    const names = uniqueEntryNames(files.map((file) => path.basename(file.filePath)));

    const zip = createZipStream(
      files.map((file, index) => ({
        name: names[index] ?? path.basename(file.filePath),
        sizeBytes: file.sizeBytes,
        // Paths come from the downloads table at run time; nothing to trace at build time.
        open: () => createReadStream(/*turbopackIgnore: true*/ paths[index] ?? ""),
      })),
    );
    zip.on("error", (error) =>
      deps.log.error({ err: error, playlistId: id.data }, "Archive failed"),
    );

    const slug = playlistSlug(found.playlist.soundcloudUrl, found.playlist.title);
    // Node types its web stream slightly differently from the DOM one Response wants;
    // the object is the same.
    return new Response(Readable.toWeb(zip) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${asciiFileName(slug)}.zip"; filename*=UTF-8''${encodeURIComponent(slug)}.zip`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
