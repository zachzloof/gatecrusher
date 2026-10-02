import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** One sentence: what goes here and how to fill it. */
  children: ReactNode;
  className?: string;
}

export function EmptyState({ children, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "rounded-panel border border-dashed border-border bg-surface-1 px-4 py-10 text-center text-13 text-text-muted",
        className,
      )}
    >
      <p className="mx-auto max-w-prose">{children}</p>
    </div>
  );
}
