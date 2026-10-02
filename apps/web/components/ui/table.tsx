import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Fixed layout and no horizontal scroll: columns are hidden as the viewport narrows
 * instead (see the frontend-design skill).
 */
function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="rounded-panel border border-border bg-surface-1">
      <table
        className={cn("w-full table-fixed border-collapse text-left text-13", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn(className)} {...props} />;
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn(className)} {...props} />;
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b border-border transition-colors duration-150 ease-out last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 z-10 h-9 border-b border-border bg-surface-1 px-2 text-label font-medium tracking-label text-text-muted uppercase first:rounded-tl-panel first:pl-3 last:rounded-tr-panel last:pr-3",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td className={cn("h-9 px-2 py-0.5 align-middle first:pl-3 last:pr-3", className)} {...props} />
  );
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
