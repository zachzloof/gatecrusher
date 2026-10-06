import type { AccountHandlerDeps } from "./account-handlers";
import { getDataDir } from "./data-dir";
import { getDb } from "./db";
import { getEnv } from "./env";
import { ingestPlaylist } from "./ingest";
import { getLogger } from "./logger";
import type { HandlerDeps } from "./playlist-handlers";
import { trackQueue } from "./queue";
import type { RunHandlerDeps } from "./run-handlers";
import { fetchPlaylistFromApiV2, verifySoundcloudToken } from "./soundcloud/api-v2";
import { createMemoryClientIdCache, type ClientIdCache } from "./soundcloud/client-id";
import { execFileRunner } from "./soundcloud/process-runner";
import { fetchPlaylistFromYtDlp } from "./soundcloud/yt-dlp";

declare global {
  var __gatecrusherClientIds: ClientIdCache | undefined;
}

/** Kept on globalThis so the discovered client_id survives dev hot reloads. */
function clientIdCache(): ClientIdCache {
  globalThis.__gatecrusherClientIds ??= createMemoryClientIdCache();
  return globalThis.__gatecrusherClientIds;
}

/** The real dependencies of the route handlers: Postgres, SoundCloud and yt-dlp. */
export function getHandlerDeps(): HandlerDeps {
  const clientIds = clientIdCache();
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

/** The real dependencies of the SoundCloud account route: Postgres and api-v2. */
export function getAccountHandlerDeps(): AccountHandlerDeps {
  const clientIds = clientIdCache();
  return {
    db: getDb().db,
    log: getLogger(),
    verifyToken: (oauthToken) => verifySoundcloudToken({ fetch, clientIds }, oauthToken),
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
