import type { Metadata } from "next";
import { GateListView } from "@/components/gate-list-view";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Manual list" };

export default function ManualListPage() {
  return (
    <>
      <PageHeader
        title="Manual list"
        description="Free-download gates to complete by hand in your own browser. Gatecrusher lists the links; automating gates is paused."
      />
      <GateListView />
    </>
  );
}
