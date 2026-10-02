import type { Metadata } from "next";
import { BuyListView } from "@/components/buy-list-view";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Buy list" };

export default function BuyListPage() {
  return (
    <>
      <PageHeader
        title="Buy list"
        description="Tracks that are only for sale. Gatecrusher lists the links and never buys anything."
      />
      <BuyListView />
    </>
  );
}
