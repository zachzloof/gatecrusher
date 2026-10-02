import type { Metadata } from "next";
import { z } from "zod";
import { PlaylistView } from "@/components/playlist-view";

export const metadata: Metadata = { title: "Playlist" };

const skippedSchema = z.coerce.number().int().min(0).max(10_000).catch(0);

export default async function PlaylistPage({ params, searchParams }: PageProps<"/playlists/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <PlaylistView playlistId={id} skippedCount={skippedSchema.parse(query.skipped ?? 0)} />;
}
