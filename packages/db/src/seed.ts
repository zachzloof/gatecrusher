import { sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { playlists, tracks } from "./schema.ts";

type NewTrack = Omit<typeof tracks.$inferInsert, "playlistId">;

const SEED_PLAYLIST = {
  soundcloudUrl: "https://soundcloud.com/gatecrusher-seed/sets/fake-crate",
  soundcloudId: "seed-playlist-1",
  title: "Fake crate (seed data)",
  owner: "gatecrusher-seed",
} satisfies typeof playlists.$inferInsert;

/** One fake track per classification. None of these URLs are real. */
const SEED_TRACKS: readonly NewTrack[] = [
  {
    soundcloudId: "seed-track-1",
    position: 0,
    title: "Native Download (Original Mix)",
    artist: "Seed Artist A",
    permalinkUrl: "https://soundcloud.com/gatecrusher-seed/native-download",
    durationMs: 372_000,
    downloadable: true,
    classification: "native",
  },
  {
    soundcloudId: "seed-track-2",
    position: 1,
    title: "Gated Bootleg (Free Download)",
    artist: "Seed Artist B",
    permalinkUrl: "https://soundcloud.com/gatecrusher-seed/gated-bootleg",
    durationMs: 298_000,
    purchaseUrl: "https://hypeddit.com/track/seed-fake",
    purchaseTitle: "Free Download",
    classification: "gate",
    gatePlatform: "hypeddit",
  },
  {
    soundcloudId: "seed-track-3",
    position: 2,
    title: "Label Release",
    artist: "Seed Artist C",
    permalinkUrl: "https://soundcloud.com/gatecrusher-seed/label-release",
    durationMs: 415_000,
    purchaseUrl: "https://seed-label.bandcamp.com/track/label-release",
    purchaseTitle: "Buy",
    classification: "buy",
  },
  {
    soundcloudId: "seed-track-4",
    position: 3,
    title: "Stream Only",
    artist: "Seed Artist D",
    permalinkUrl: "https://soundcloud.com/gatecrusher-seed/stream-only",
    durationMs: 241_000,
    classification: "none",
  },
];

export interface SeedSummary {
  playlistId: string;
  tracks: number;
}

/** Inserts one fake playlist with a few fake tracks. Idempotent: re-running updates. */
export async function seed(db: Database): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    const [playlist] = await tx
      .insert(playlists)
      .values(SEED_PLAYLIST)
      .onConflictDoUpdate({
        target: playlists.soundcloudUrl,
        set: { title: SEED_PLAYLIST.title, owner: SEED_PLAYLIST.owner },
      })
      .returning({ id: playlists.id });
    if (playlist === undefined) throw new Error("Seed playlist upsert returned no row");

    const rows = await tx
      .insert(tracks)
      .values(SEED_TRACKS.map((track) => ({ ...track, playlistId: playlist.id })))
      .onConflictDoUpdate({
        target: [tracks.playlistId, tracks.soundcloudId],
        set: {
          position: sql`excluded.position`,
          title: sql`excluded.title`,
          artist: sql`excluded.artist`,
          classification: sql`excluded.classification`,
        },
      })
      .returning({ id: tracks.id });

    return { playlistId: playlist.id, tracks: rows.length };
  });
}
