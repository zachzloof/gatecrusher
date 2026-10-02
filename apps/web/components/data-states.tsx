import { Button } from "@/components/ui/button";
import type { ApiFailure } from "@/lib/use-api";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  /** What failed, in plain words: "Could not load the playlists". */
  title: string;
  error: ApiFailure;
  onRetry: () => void;
}

/** The error state of a data view: what failed, a retry, and the detail collapsed. */
export function ErrorState({ title, error, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className="rounded-panel border border-border bg-surface-1 p-4">
      <p className="text-sm font-medium text-text">{title}</p>
      <p className="mt-1 text-13 text-text-muted">{error.message}</p>
      <Button className="mt-3" size="sm" onClick={onRetry}>
        Try again
      </Button>
      {(error.detail !== undefined || error.status !== undefined) && (
        <details className="mt-3 text-13 text-text-muted">
          <summary className="cursor-pointer">Technical detail</summary>
          <pre className="mt-2 rounded-control bg-surface-2 p-3 font-mono text-xs break-words whitespace-pre-wrap text-text">
            {[error.status !== undefined ? `HTTP ${error.status}` : null, error.detail]
              .filter((line) => line !== null && line !== undefined)
              .join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

interface RowsSkeletonProps {
  rows?: number;
  /** What is loading, for screen readers: "Loading tracks". */
  label: string;
  className?: string;
}

/** Loading state: rows the height of the real ones, so nothing jumps when data arrives. */
export function RowsSkeleton({ rows = 8, label, className }: RowsSkeletonProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("rounded-panel border border-border bg-surface-1", className)}
    >
      <div className="h-9 border-b border-border" />
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex h-9 items-center gap-3 border-b border-border px-3 last:border-b-0"
        >
          <div className="size-8 shrink-0 rounded-control bg-surface-2" />
          <div className="h-3 w-2/5 rounded-control bg-surface-2" />
          <div className="ml-auto h-3 w-16 rounded-control bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
