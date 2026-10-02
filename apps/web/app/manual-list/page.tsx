import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Manual list" };

export default function ManualListPage() {
  return (
    <>
      <PageHeader
        title="Manual list"
        description="Tracks that could not be downloaded automatically, each with a reason and a link."
      />
      <EmptyState>
        Nothing here. Tracks land on this list only when a link is dead, a file is gone, an account
        is required, or you give up on one.
      </EmptyState>
    </>
  );
}
