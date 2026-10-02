import { getRunHandlerDeps } from "@/lib/handler-deps";
import { handleRunNative } from "@/lib/run-handlers";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: RouteContext<"/api/playlists/[id]/runs">,
): Promise<Response> {
  const { id } = await context.params;
  return handleRunNative(id, getRunHandlerDeps());
}
