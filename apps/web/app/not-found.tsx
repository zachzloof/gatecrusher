import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="rounded-panel border border-border bg-surface-1 p-5">
      <h1 className="text-xl font-semibold text-text">Page not found</h1>
      <p className="mt-1 text-13 text-text-muted">There is nothing at this address.</p>
      <Button asChild className="mt-4">
        <Link href="/playlists">Go to playlists</Link>
      </Button>
    </div>
  );
}
