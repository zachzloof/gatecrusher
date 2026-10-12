"use client";

import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { healthResponseSchema, type HealthResponse } from "@/lib/api-schemas";
import { useDesktop } from "@/lib/desktop";
import { describeProblem, type SystemProblem } from "@/lib/system-status";

const POLL_INTERVAL_MS = 10_000;
/** How long "Still not up." stays after a re-check that found the same problem. */
const STILL_DOWN_NOTICE_MS = 3_000;

/** `null` when the web server did not answer with a health body. */
async function fetchHealth(signal: AbortSignal): Promise<HealthResponse | null> {
  try {
    // /api/health answers 503 with the same body when a service is down.
    const response = await fetch("/api/health", { cache: "no-store", signal });
    const parsed = healthResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    // Network failure or a non-JSON body: the server is not answering properly.
    return null;
  }
}

type Recheck = "idle" | "checking" | "still-down";

/**
 * Thin banner at the top of every page while Postgres or the worker is not
 * available. Renders nothing until the first check has answered, and nothing when
 * everything is up. "It's up" re-checks at once instead of waiting for the next poll,
 * so the banner goes away the moment the user has started the missing service.
 */
export function SystemStatusBanner() {
  const [problem, setProblem] = useState<SystemProblem | null>(null);
  const [recheck, setRecheck] = useState<Recheck>("idle");
  const desktop = useDesktop() !== null;
  // The controller of the current mount, so a click can share its abort signal.
  const controllerRef = useRef<AbortController | null>(null);

  const check = useCallback(async (): Promise<SystemProblem | null> => {
    const controller = controllerRef.current;
    if (controller === null) return null;
    const health = await fetchHealth(controller.signal);
    if (controller.signal.aborted) return null;
    const next = describeProblem(health, { desktop });
    setProblem(next);
    return next;
  }, [desktop]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;

    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      controllerRef.current = null;
      clearInterval(timer);
    };
  }, [check]);

  useEffect(() => {
    if (recheck !== "still-down") return;
    const timer = setTimeout(() => setRecheck("idle"), STILL_DOWN_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [recheck]);

  const onItsUp = async (): Promise<void> => {
    setRecheck("checking");
    const next = await check();
    if (controllerRef.current?.signal.aborted === true) return;
    // A problem that is gone unmounts the row, so only the failure needs a state.
    setRecheck(next === null ? "idle" : "still-down");
  };

  return (
    <div role="status" aria-live="polite">
      {problem !== null && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-surface-1 px-4 py-2 text-13 text-text lg:px-6">
          <TriangleAlert className="size-4 shrink-0 text-warn" aria-hidden="true" />
          <span>{problem.message}</span>
          {problem.command !== undefined && (
            <code className="rounded-control bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">
              {problem.command}
            </code>
          )}
          <button
            type="button"
            onClick={() => void onItsUp()}
            disabled={recheck === "checking"}
            className="ml-auto text-13 text-text-muted underline-offset-2 hover:text-text hover:underline disabled:cursor-default disabled:hover:no-underline"
          >
            {recheck === "checking" ? "Checking…" : "It's up"}
          </button>
          {recheck === "still-down" && <span className="text-text-muted">Still not up.</span>}
        </div>
      )}
    </div>
  );
}
