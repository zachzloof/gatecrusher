// The logic behind the run and screenshot routes, with everything they touch passed in,
// so tests can run them against a throwaway database, a fake queue and a temp data dir.
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { playlistSlug } from "@gatecrusher/core";
import {
  isRecordedScreenshot,
  listPlaylistDownloads,
  startNativeRun,
  type Database,
} from "@gatecrusher/db";
import { z } from "zod";
import { runNativeResponseSchema } from "./api-schemas";
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

/** How track jobs reach the worker. */
export interface TrackQueue {
  /** Whether Redis is reachable right now. Never rejects. */
  isReady(): Promise<boolean>;
  /** Hands jobs to the worker, in order. Rejects when Redis cannot be reached. */
  enqueue(jobIds: readonly string[]): Promise<void>;
}

export interface RunHandlerDeps {
  db: Database;
  queue: TrackQueue;
  /** Absolute path of the data dir. */
  dataDir: string;
  log: HandlerLog;
}

const QUEUE_DOWN =
  "Could not reach Redis, so nothing was started. Check `docker compose up -d` is running, then try again.";

/**
 * POST /api/playlists/:id/runs — "Download native tracks".
 *
 * Queues every native track that has no verified download yet, one at a time for the
 * worker, and sends paused tracks back for another look. Safe to click repeatedly.
 */
export function handleRunNative(playlistId: string, deps: RunHandlerDeps): Promise<Response> {
  return guarded(deps.log, "POST /api/playlists/:id/runs", async () => {
    const id = z.uuid().safeParse(playlistId);
    if (!id.success) return errorResponse(404, "not_found", "No such playlist.");

    // Checked first, so a Redis outage does not leave jobs queued with nobody told.
    if (!(await deps.queue.isReady())) return errorResponse(503, "queue_unavailable", QUEUE_DOWN);

    const started = await withTimeout(startNativeRun(deps.db, id.data), READ_TIMEOUT_MS);
    if (!started.ok) return errorResponse(404, "not_found", started.reason);

    // Jobs that were already queued are handed over again too: if an earlier hand-over
    // failed they would otherwise wait forever, and the worker skips duplicates.
    const jobIds = [...started.resumedJobIds, ...started.queuedJobIds, ...started.newJobIds];
    if (jobIds.length > 0) {
      try {
        await deps.queue.enqueue(jobIds);
      } catch (error) {
        deps.log.error({ err: error, playlistId: id.data }, "Could not enqueue track jobs");
        return errorResponse(
          503,
          "queue_unavailable",
          "The tracks are queued but could not be handed to the worker because Redis went away. Click Download native tracks again once it is back.",
        );
      }
    }

    return Response.json(
      runNativeResponseSchema.parse({
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

/**
 * GET /api/playlists/:id/archive — every verified download of a playlist as one zip,
 * streamed straight from the files on disk. Only paths recorded in `downloads` that
 * resolve inside the data dir's downloads folder are ever read.
 */
export function handleArchive(playlistId: string, deps: RunHandlerDeps): Promise<Response> {
  return guarded(deps.log, "GET /api/playlists/:id/archive", async () => {
    const id = z.uuid().safeParse(playlistId);
    if (!id.success) return errorResponse(404, "not_found", "No such playlist.");
    const found = await withTimeout(listPlaylistDownloads(deps.db, id.data), READ_TIMEOUT_MS);
    if (found === null) return errorResponse(404, "not_found", "No such playlist.");
    if (found.files.length === 0) {
      return errorResponse(404, "not_found", "Nothing has been downloaded for this playlist yet.");
    }

    const root = path.resolve(deps.dataDir, "downloads");
    const paths = found.files.map((file) => path.resolve(deps.dataDir, file.filePath));
    if (paths.some((file) => !file.startsWith(root + path.sep))) {
      // A recorded path outside the downloads folder means the database was tampered
      // with; nothing is served from it.
      throw new Error("A recorded download path is outside the downloads folder");
    }
    const names = uniqueEntryNames(found.files.map((file) => path.basename(file.filePath)));

    const zip = createZipStream(
      found.files.map((file, index) => ({
        name: names[index] ?? path.basename(file.filePath),
        sizeBytes: file.sizeBytes,
        open: () => createReadStream(paths[index] ?? ""),
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
