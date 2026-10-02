"use client";

import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { apiErrorSchema } from "./api-schemas";

export interface ApiFailure {
  /** Plain words: what failed and what to do. */
  message: string;
  /** Technical detail for the collapsed section. */
  detail?: string;
  status?: number;
}

export type ApiState<T> =
  { status: "loading" } | { status: "error"; error: ApiFailure } | { status: "ok"; data: T };

/** GETs a JSON API route and validates the answer. Never rejects (except on abort). */
export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; error: ApiFailure }> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(path, { cache: "no-store", signal });
    body = await response.json();
  } catch (error) {
    if (signal?.aborted === true) throw error;
    // fetch rejected or the body was not JSON: the server is not answering properly.
    return {
      ok: false,
      error: { message: "Could not reach the server. Check it is running, then try again." },
    };
  }

  if (response.ok) {
    const parsed = schema.safeParse(body);
    if (parsed.success) return { ok: true, data: parsed.data };
    return {
      ok: false,
      error: {
        message: "The server sent an unexpected response.",
        detail: `${path}: response did not match the expected shape`,
        status: response.status,
      },
    };
  }

  const failure = apiErrorSchema.safeParse(body);
  return {
    ok: false,
    error: failure.success
      ? {
          message: failure.data.error.message,
          detail: `${failure.data.error.code}${failure.data.error.detail === undefined ? "" : `: ${failure.data.error.detail}`}`,
          status: response.status,
        }
      : { message: "The server sent an unexpected response.", status: response.status },
  };
}

/**
 * Loads a JSON API route for a view. `schema` must be a stable reference (a
 * module-level constant), since a new one refetches.
 */
export function useApi<S extends z.ZodType>(
  path: string,
  schema: S,
): { state: ApiState<z.infer<S>>; reload: () => void; refresh: () => void } {
  const [state, setState] = useState<ApiState<z.infer<S>>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getJson(path, schema, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.ok) {
          setState({ status: "ok", data: result.data });
          return;
        }
        // A failed background refresh keeps what is on screen: the next one tries
        // again, and the system banner reports an outage. Only a first load or an
        // explicit reload turns into the error state.
        setState((current) =>
          current.status === "ok" ? current : { status: "error", error: result.error },
        );
      },
      () => {
        // Aborted on unmount or reload: there is nothing left to update.
      },
    );
    return () => controller.abort();
  }, [path, schema, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  /** Fetches again while keeping what is on screen, for views that update live. */
  const refresh = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return { state, reload, refresh };
}
