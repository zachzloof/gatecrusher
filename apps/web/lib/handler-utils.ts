// Shared by the route handler modules: typed error bodies and the 500 safety net.
import type { ApiError, ApiErrorCode } from "./api-schemas";

export interface HandlerLog {
  error(fields: Record<string, unknown>, message: string): void;
}

export const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A read is a couple of small queries. With Postgres down the driver keeps retrying
 * the connection, so without a limit the UI would wait instead of showing its error.
 */
export const READ_TIMEOUT_MS = 8_000;

export function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  detail?: string,
): Response {
  const body: ApiError = { error: { code, message, ...(detail === undefined ? {} : { detail }) } };
  return Response.json(body, { status, headers: NO_STORE });
}

/** Runs a handler body; anything it throws (database down, a bug) becomes a typed 500. */
export async function guarded(
  log: HandlerLog,
  route: string,
  body: () => Promise<Response>,
): Promise<Response> {
  try {
    return await body();
  } catch (error) {
    log.error({ err: error, route }, "Request failed");
    return errorResponse(
      500,
      "internal",
      "Something went wrong on the server. Check that Postgres is running, then try again.",
      error instanceof Error ? error.name : undefined,
    );
  }
}
