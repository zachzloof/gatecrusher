import { getMyPlaylistsHandlerDeps } from "@/lib/handler-deps";
import { handleListMyPlaylists } from "@/lib/my-playlists-handlers";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleListMyPlaylists(getMyPlaylistsHandlerDeps());
}
