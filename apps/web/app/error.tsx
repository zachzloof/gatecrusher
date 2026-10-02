"use client";

import { Button } from "@/components/ui/button";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <div role="alert" className="rounded-panel border border-border bg-surface-1 p-5">
      <h1 className="text-xl font-semibold text-text">This page failed to load</h1>
      <p className="mt-1 text-13 text-text-muted">
        Something went wrong while rendering it. Try again; if it keeps failing, check the web
        server log.
      </p>
      <Button className="mt-4" onClick={reset}>
        Try again
      </Button>
      <details className="mt-4 text-13 text-text-muted">
        <summary className="cursor-pointer">Technical detail</summary>
        <pre className="mt-2 overflow-x-auto rounded-control bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap text-text">
          {error.message}
          {error.digest !== undefined && `\ndigest: ${error.digest}`}
        </pre>
      </details>
    </div>
  );
}
