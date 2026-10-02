import { getHandlerDeps } from "@/lib/handler-deps";
import { handleAddPlaylist, handleListPlaylists } from "@/lib/playlist-handlers";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleListPlaylists(getHandlerDeps());
}

export function POST(request: Request): Promise<Response> {
  return handleAddPlaylist(request, getHandlerDeps());
}
