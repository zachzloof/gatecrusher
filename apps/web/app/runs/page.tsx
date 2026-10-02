import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";

export const metadata: Metadata = { title: "Runs" };

export default function RunsPage() {
  return (
    <>
      <PageHeader
        title="Runs"
        description="Each run works through one playlist's downloads, one track at a time."
      />

      {/* Placeholder for the Needs-you cards (slice 4). Pinned above everything else. */}
      <section aria-labelledby="needs-you-heading" aria-live="polite" className="mb-8">
        <SectionLabel id="needs-you-heading" className="text-accent">
          Needs you
        </SectionLabel>
        <EmptyState className="border-l-2 border-l-accent border-solid text-left">
          Nothing is waiting on you. Tracks that hit a captcha, an email confirmation or a login
          prompt will pause here until you click Continue.
        </EmptyState>
      </section>

      <section aria-labelledby="runs-heading">
        <SectionLabel id="runs-heading">All runs</SectionLabel>
        <EmptyState>No runs yet. Add a playlist, then start a run from it.</EmptyState>
      </section>
    </>
  );
}
