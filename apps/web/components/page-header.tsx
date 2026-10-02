import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description: string;
  /** The page's single primary action, if it has one. */
  action?: ReactNode;
}

export function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-text">{title}</h1>
        <p className="mt-1 text-13 text-text-muted">{description}</p>
      </div>
      {action}
    </header>
  );
}
