import { getHandlerDeps } from "@/lib/handler-deps";
import { handleBuyList } from "@/lib/playlist-handlers";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleBuyList(getHandlerDeps());
}
