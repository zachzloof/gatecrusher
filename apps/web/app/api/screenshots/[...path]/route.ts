import { getRunHandlerDeps } from "@/lib/handler-deps";
import { handleScreenshot } from "@/lib/run-handlers";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/screenshots/[...path]">,
): Promise<Response> {
  const { path } = await context.params;
  return handleScreenshot(path, getRunHandlerDeps());
}
