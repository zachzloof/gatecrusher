import { getHandlerDeps } from "@/lib/handler-deps";
import { handleGetPlaylist } from "@/lib/playlist-handlers";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/playlists/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return handleGetPlaylist(id, getHandlerDeps());
}
