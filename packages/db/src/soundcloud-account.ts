// The SoundCloud login: an `oauth_token` the owner pasted in, and who it belongs to.
// Only `getSoundcloudOauthToken` ever reads the token back: for the worker's cookie
// file, and for the web app's own requests to SoundCloud on the owner's behalf.
import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { soundcloudAccount } from "./schema.ts";

const SINGLE_ROW = 1;

/** Who is connected. Deliberately without the token, so it can go to the UI as it is. */
export interface SoundcloudAccountSummary {
  soundcloudUserId: string;
  username: string;
  verifiedAt: Date;
  connectedAt: Date;
}

export interface SaveSoundcloudAccountInput {
  /** Already checked with SoundCloud. */
  oauthToken: string;
  soundcloudUserId: string;
  username: string;
}

export async function getSoundcloudAccount(db: Database): Promise<SoundcloudAccountSummary | null> {
  const [row] = await db
    .select({
      soundcloudUserId: soundcloudAccount.soundcloudUserId,
      username: soundcloudAccount.username,
      verifiedAt: soundcloudAccount.verifiedAt,
      connectedAt: soundcloudAccount.createdAt,
    })
    .from(soundcloudAccount)
    .where(eq(soundcloudAccount.id, SINGLE_ROW));
  return row ?? null;
}

/**
 * The token itself, or null when none is connected. For the worker's yt-dlp cookie
 * file and the web app's authenticated SoundCloud requests only; never for a response.
 */
export async function getSoundcloudOauthToken(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ oauthToken: soundcloudAccount.oauthToken })
    .from(soundcloudAccount)
    .where(eq(soundcloudAccount.id, SINGLE_ROW));
  return row?.oauthToken ?? null;
}

/**
 * What went wrong, without the query: Drizzle's error message and `params` carry every
 * bound value, the token among them, and whoever catches the error logs it.
 */
function withoutParams(error: unknown): Error {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause instanceof Error && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : error instanceof Error
        ? error.name
        : "unknown error";
  return new Error(`Could not save the SoundCloud account (${code})`);
}

/**
 * Connects an account, replacing any earlier one. Connecting a different account
 * counts as a fresh connection; a new token for the same account keeps the date.
 */
export async function saveSoundcloudAccount(
  db: Database,
  input: SaveSoundcloudAccountInput,
): Promise<SoundcloudAccountSummary> {
  try {
    return await upsertAccount(db, input);
  } catch (error) {
    throw withoutParams(error);
  }
}

async function upsertAccount(
  db: Database,
  input: SaveSoundcloudAccountInput,
): Promise<SoundcloudAccountSummary> {
  const [row] = await db
    .insert(soundcloudAccount)
    .values({ id: SINGLE_ROW, ...input, verifiedAt: sql`now()` })
    .onConflictDoUpdate({
      target: soundcloudAccount.id,
      set: {
        ...input,
        verifiedAt: sql`now()`,
        updatedAt: sql`now()`,
        createdAt: sql`case when ${soundcloudAccount.soundcloudUserId} = ${input.soundcloudUserId} then ${soundcloudAccount.createdAt} else now() end`,
      },
    })
    .returning({
      soundcloudUserId: soundcloudAccount.soundcloudUserId,
      username: soundcloudAccount.username,
      verifiedAt: soundcloudAccount.verifiedAt,
      connectedAt: soundcloudAccount.createdAt,
    });
  if (row === undefined) throw new Error("SoundCloud account upsert returned no row");
  return row;
}

/** Forgets the login. Returns whether there was one. */
export async function deleteSoundcloudAccount(db: Database): Promise<boolean> {
  const deleted = await db
    .delete(soundcloudAccount)
    .where(eq(soundcloudAccount.id, SINGLE_ROW))
    .returning({ id: soundcloudAccount.id });
  return deleted.length > 0;
}
