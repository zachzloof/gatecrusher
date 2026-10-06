import type { HandlerLog } from "./handler-utils";
import { withTimeout } from "./with-timeout";

/**
 * Opening the app is short: with Postgres down the driver keeps retrying, and the
 * playlists page explains an outage better than a blank wait does.
 */
const LOOKUP_TIMEOUT_MS = 2_000;

export type HomeDestination = "/connect" | "/playlists";

/**
 * Where opening the app lands: the Connect SoundCloud screen until an account is
 * connected, the playlists otherwise. If the account cannot be looked up, the playlists,
 * where the system banner says what is down.
 */
export async function homeDestination(
  lookupAccount: () => Promise<unknown>,
  log: HandlerLog,
): Promise<HomeDestination> {
  try {
    const account = await withTimeout(lookupAccount(), LOOKUP_TIMEOUT_MS);
    return account === null ? "/connect" : "/playlists";
  } catch (error) {
    log.error({ err: error }, "Could not look up the SoundCloud account for the home page");
    return "/playlists";
  }
}
