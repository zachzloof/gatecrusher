import { getHandlerDeps } from "@/lib/handler-deps";
import { handleGateList } from "@/lib/playlist-handlers";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleGateList(getHandlerDeps());
}
