import { getRunHandlerDeps } from "@/lib/handler-deps";
import { handleArchive } from "@/lib/run-handlers";

export const dynamic = "force-dynamic";

/** The whole playlist. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/playlists/[id]/archive">,
): Promise<Response> {
  const { id } = await context.params;
  return handleArchive(id, getRunHandlerDeps());
}

/** Only the tracks named in the form's `tracks` field. A form, so a long list fits. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/playlists/[id]/archive">,
): Promise<Response> {
  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  const tracks = form?.get("tracks");
  return handleArchive(id, getRunHandlerDeps(), typeof tracks === "string" ? tracks : null);
}
