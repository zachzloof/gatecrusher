import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Small uppercase heading above a section of a page. */
export function SectionLabel({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn(
        "mb-2 text-label font-medium tracking-label text-text-muted uppercase",
        className,
      )}
      {...props}
    />
  );
}
