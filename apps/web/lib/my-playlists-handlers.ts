// The logic behind /api/soundcloud-account/playlists: the connected account's own
// SoundCloud playlists, for the "From my SoundCloud" picker. The token is read from
// Postgres for the one request and never goes out in the answer.
import { getSoundcloudAccount, getSoundcloudOauthToken, type Database } from "@gatecrusher/db";
import { myPlaylistsResponseSchema, type MyPlaylistsResponse } from "./api-schemas";
import {
  errorResponse,
  guarded,
  NO_STORE,
  READ_TIMEOUT_MS,
  type HandlerLog,
} from "./handler-utils";
import type { MyPlaylistsResult } from "./soundcloud/api-v2";
import { withTimeout } from "./with-timeout";

export interface MyPlaylistsHandlerDeps {
  db: Database;
  log: HandlerLog;
  /** Lists the playlists of the account a token belongs to. Never rejects. */
  listPlaylists(oauthToken: string, soundcloudUserId: string): Promise<MyPlaylistsResult>;
}

/** GET /api/soundcloud-account/playlists — the connected account's playlists. */
export function handleListMyPlaylists(deps: MyPlaylistsHandlerDeps): Promise<Response> {
  return guarded(deps.log, "GET /api/soundcloud-account/playlists", async () => {
    const [account, token] = await withTimeout(
      Promise.all([getSoundcloudAccount(deps.db), getSoundcloudOauthToken(deps.db)]),
      READ_TIMEOUT_MS,
    );
    if (account === null || token === null) {
      return errorResponse(
        409,
        "soundcloud_not_connected",
        "Connect a SoundCloud account first to pick from its playlists.",
      );
    }

    const listed = await deps.listPlaylists(token, account.soundcloudUserId);
    if (!listed.ok) {
      if (listed.kind === "rejected") {
        return errorResponse(
          422,
          "soundcloud_token_rejected",
          "SoundCloud no longer accepts the saved login. Connect the account again.",
          listed.reason,
        );
      }
      return errorResponse(
        502,
        "upstream_failed",
        "Could not read the playlists from SoundCloud. Try again in a minute.",
        listed.reason,
      );
    }

    const body: MyPlaylistsResponse = { playlists: listed.playlists, listings: listed.listings };
    return Response.json(myPlaylistsResponseSchema.parse(body), { headers: NO_STORE });
  });
}
