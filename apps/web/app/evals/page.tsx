import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Evals" };

export default function EvalsPage() {
  return (
    <>
      <PageHeader
        title="Evals"
        description="Success, hand-over and manual rates for each gate platform."
      />
      <EmptyState>No data yet. Numbers appear here after the first run finishes.</EmptyState>
    </>
  );
}
