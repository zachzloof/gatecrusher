import { getRunHandlerDeps } from "@/lib/handler-deps";
import { handleArchive } from "@/lib/run-handlers";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/playlists/[id]/archive">,
): Promise<Response> {
  const { id } = await context.params;
  return handleArchive(id, getRunHandlerDeps());
}
