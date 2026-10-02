/** Skeleton matching the page layout: header lines, then a panel. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="mb-6">
        <div className="h-7 w-40 rounded-control bg-surface-2" />
        <div className="mt-2 h-4 w-80 max-w-full rounded-control bg-surface-1" />
      </div>
      <div className="h-28 rounded-panel border border-border bg-surface-1" />
    </div>
  );
}
