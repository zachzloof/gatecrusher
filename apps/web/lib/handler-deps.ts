import { getDataDir } from "./data-dir";
import { getDb } from "./db";
import { getEnv } from "./env";
import { ingestPlaylist } from "./ingest";
import { getLogger } from "./logger";
import type { HandlerDeps } from "./playlist-handlers";
import { trackQueue } from "./queue";
import type { RunHandlerDeps } from "./run-handlers";
import { fetchPlaylistFromApiV2 } from "./soundcloud/api-v2";
import { createMemoryClientIdCache, type ClientIdCache } from "./soundcloud/client-id";
import { execFileRunner } from "./soundcloud/process-runner";
import { fetchPlaylistFromYtDlp } from "./soundcloud/yt-dlp";

declare global {
  var __gatecrusherClientIds: ClientIdCache | undefined;
}

/** The real dependencies of the route handlers: Postgres, SoundCloud and yt-dlp. */
export function getHandlerDeps(): HandlerDeps {
  // Kept on globalThis so the discovered client_id survives dev hot reloads.
  globalThis.__gatecrusherClientIds ??= createMemoryClientIdCache();
  const clientIds = globalThis.__gatecrusherClientIds;
  const { db } = getDb();
  const log = getLogger();

  return {
    db,
    log,
    ingest: (playlistUrl) =>
      ingestPlaylist(
        {
          db,
          log,
          apiV2: (url) => fetchPlaylistFromApiV2({ fetch, clientIds }, url),
          ytDlp: (url) =>
            fetchPlaylistFromYtDlp({ runner: execFileRunner, command: getEnv().YT_DLP_PATH }, url),
        },
        playlistUrl,
      ),
  };
}

/** The real dependencies of the run and screenshot routes: Postgres, the queue, the data dir. */
export function getRunHandlerDeps(): RunHandlerDeps {
  return {
    db: getDb().db,
    queue: trackQueue,
    dataDir: getDataDir(),
    log: getLogger(),
  };
}
