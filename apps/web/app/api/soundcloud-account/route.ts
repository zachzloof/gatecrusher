import {
  handleConnectAccount,
  handleDisconnectAccount,
  handleGetAccount,
} from "@/lib/account-handlers";
import { getAccountHandlerDeps } from "@/lib/handler-deps";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleGetAccount(getAccountHandlerDeps());
}

export function PUT(request: Request): Promise<Response> {
  return handleConnectAccount(request, getAccountHandlerDeps());
}

export function DELETE(): Promise<Response> {
  return handleDisconnectAccount(getAccountHandlerDeps());
}
