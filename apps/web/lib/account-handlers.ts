// The logic behind /api/soundcloud-account: which SoundCloud login downloads run as.
// The token comes in once, is checked with SoundCloud and stored; it never goes back out.
import {
  deleteSoundcloudAccount,
  getSoundcloudAccount,
  saveSoundcloudAccount,
  type Database,
  type SoundcloudAccountSummary,
} from "@gatecrusher/db";
import {
  connectSoundcloudRequestSchema,
  soundcloudAccountResponseSchema,
  type SoundcloudAccountResponse,
} from "./api-schemas";
import {
  errorResponse,
  guarded,
  NO_STORE,
  READ_TIMEOUT_MS,
  type HandlerLog,
} from "./handler-utils";
import type { VerifyTokenResult } from "./soundcloud/api-v2";
import { withTimeout } from "./with-timeout";

export interface AccountHandlerDeps {
  db: Database;
  log: HandlerLog;
  /** Asks SoundCloud who a token belongs to. Never rejects. */
  verifyToken(oauthToken: string): Promise<VerifyTokenResult>;
}

function toResponse(account: SoundcloudAccountSummary | null): Response {
  const body: SoundcloudAccountResponse =
    account === null
      ? { connected: false }
      : {
          connected: true,
          username: account.username,
          connectedAt: account.connectedAt.toISOString(),
          verifiedAt: account.verifiedAt.toISOString(),
        };
  return Response.json(soundcloudAccountResponseSchema.parse(body), { headers: NO_STORE });
}

/** GET /api/soundcloud-account — who is connected, if anyone. */
export function handleGetAccount(deps: AccountHandlerDeps): Promise<Response> {
  return guarded(deps.log, "GET /api/soundcloud-account", async () =>
    toResponse(await withTimeout(getSoundcloudAccount(deps.db), READ_TIMEOUT_MS)),
  );
}

/**
 * PUT /api/soundcloud-account — connects the account a pasted `oauth_token` belongs to,
 * replacing any earlier one. Nothing is stored unless SoundCloud accepts the token.
 */
export function handleConnectAccount(
  request: Request,
  deps: AccountHandlerDeps,
): Promise<Response> {
  return guarded(deps.log, "PUT /api/soundcloud-account", async () => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // A body that is not JSON is the client's mistake, answered as such.
      return errorResponse(400, "invalid_json", "Request body must be JSON.");
    }

    const parsed = connectSoundcloudRequestSchema.safeParse(body);
    if (!parsed.success) {
      // The schema's messages never repeat the value, so this cannot echo the token.
      const message = parsed.error.issues[0]?.message ?? "Invalid request.";
      return errorResponse(400, "invalid_request", message);
    }
    const { token } = parsed.data;

    const verified = await deps.verifyToken(token);
    if (!verified.ok) {
      if (verified.kind === "rejected") {
        return errorResponse(
          422,
          "soundcloud_token_rejected",
          "SoundCloud did not accept that token. Check you copied the whole oauth_token value while signed in, then try again.",
          verified.reason,
        );
      }
      return errorResponse(
        502,
        "upstream_failed",
        "Could not reach SoundCloud to check the token. Try again in a minute.",
        verified.reason,
      );
    }

    const saved = await saveSoundcloudAccount(deps.db, {
      oauthToken: token,
      soundcloudUserId: verified.soundcloudUserId,
      username: verified.username,
    });
    return toResponse(saved);
  });
}

/** DELETE /api/soundcloud-account — forgets the login. Safe to repeat. */
export function handleDisconnectAccount(deps: AccountHandlerDeps): Promise<Response> {
  return guarded(deps.log, "DELETE /api/soundcloud-account", async () => {
    await withTimeout(deleteSoundcloudAccount(deps.db), READ_TIMEOUT_MS);
    return toResponse(null);
  });
}
