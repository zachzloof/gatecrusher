"use client";

import { LinkListView } from "@/components/link-list-view";
import { gateListResponseSchema } from "@/lib/api-schemas";
import { gateItemToLink, linkListCsv, linkListCsvFilename } from "@/lib/link-list-csv";
import type { LinkListItem } from "@/lib/link-list-csv";
import { useApi, type ApiState } from "@/lib/use-api";

export function GateListView() {
  const { state, reload } = useApi("/api/gate-list", gateListResponseSchema);
  const items: ApiState<readonly LinkListItem[]> =
    state.status === "ok" ? { status: "ok", data: state.data.items.map(gateItemToLink) } : state;

  return (
    <LinkListView
      state={items}
      onRetry={reload}
      tableLabel="Gate tracks"
      sourceLabel="Gate"
      sourceClassName="text-info"
      loadingLabel="Loading the gate list"
      errorTitle="Could not load the gate list"
      empty="No gate tracks yet. They appear here once a playlist is classified."
      csv={(rows) => ({
        text: linkListCsv("Gate", rows),
        filename: linkListCsvFilename("gate-list", new Date()),
      })}
    />
  );
}
