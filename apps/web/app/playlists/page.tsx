import type { Metadata } from "next";
import { AddPlaylistDialog } from "@/components/add-playlist-dialog";
import { PageHeader } from "@/components/page-header";
import { PlaylistsView } from "@/components/playlists-view";

export const metadata: Metadata = { title: "Playlists" };

export default function PlaylistsPage() {
  return (
    <>
      <PageHeader
        title="Playlists"
        description="SoundCloud playlists and how each track in them can be downloaded."
        action={<AddPlaylistDialog />}
      />
      <PlaylistsView />
    </>
  );
}
