"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { healthResponseSchema, type HealthResponse } from "@/lib/api-schemas";
import { useDesktop } from "@/lib/desktop";
import { describeProblem, type SystemProblem } from "@/lib/system-status";

const POLL_INTERVAL_MS = 10_000;

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

/**
 * Thin banner at the top of every page while Postgres or the worker is not
 * available. Renders nothing until the first check has answered, and nothing when
 * everything is up.
 */
export function SystemStatusBanner() {
  const [problem, setProblem] = useState<SystemProblem | null>(null);
  const desktop = useDesktop() !== null;

  useEffect(() => {
    const controller = new AbortController();

    const check = async (): Promise<void> => {
      const health = await fetchHealth(controller.signal);
      if (!controller.signal.aborted) setProblem(describeProblem(health, { desktop }));
    };

    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [desktop]);

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
        </div>
      )}
    </div>
  );
}
