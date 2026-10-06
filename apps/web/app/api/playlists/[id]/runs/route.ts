import { getRunHandlerDeps } from "@/lib/handler-deps";
import { handleCancelRun, handleStartRun } from "@/lib/run-handlers";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: RouteContext<"/api/playlists/[id]/runs">,
): Promise<Response> {
  const { id } = await context.params;
  return handleStartRun(id, getRunHandlerDeps());
}

export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/playlists/[id]/runs">,
): Promise<Response> {
  const { id } = await context.params;
  return handleCancelRun(id, getRunHandlerDeps());
}
