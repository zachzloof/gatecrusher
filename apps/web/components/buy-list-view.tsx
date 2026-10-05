"use client";

import { LinkListView } from "@/components/link-list-view";
import { buyListResponseSchema } from "@/lib/api-schemas";
import { buyItemToLink, linkListCsv, linkListCsvFilename } from "@/lib/link-list-csv";
import { useApi, type ApiState } from "@/lib/use-api";
import type { LinkListItem } from "@/lib/link-list-csv";

export function BuyListView() {
  const { state, reload } = useApi("/api/buy-list", buyListResponseSchema);
  const items: ApiState<readonly LinkListItem[]> =
    state.status === "ok" ? { status: "ok", data: state.data.items.map(buyItemToLink) } : state;

  return (
    <LinkListView
      state={items}
      onRetry={reload}
      tableLabel="Tracks to buy"
      sourceLabel="Store"
      sourceClassName="text-warn"
      loadingLabel="Loading the buy list"
      errorTitle="Could not load the buy list"
      empty="No tracks to buy yet. They appear here once a playlist is classified."
      csv={(rows) => ({
        text: linkListCsv("Store", rows),
        filename: linkListCsvFilename("buy-list", new Date()),
      })}
    />
  );
}
