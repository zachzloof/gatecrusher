"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { ErrorState, RowsSkeleton } from "@/components/data-states";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buyListResponseSchema, type BuyListItemDto } from "@/lib/api-schemas";
import { buyListCsv, buyListCsvFilename } from "@/lib/buy-list-csv";
import { displayUrl, middleTruncate, safeHref } from "@/lib/format";
import { useApi } from "@/lib/use-api";

/** Hands the browser a CSV file to save. The BOM makes Excel read it as UTF-8. */
function downloadCsv(items: readonly BuyListItemDto[]): void {
  const blob = new Blob(["﻿", buyListCsv(items)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buyListCsvFilename(new Date());
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked a moment later, so the browser has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function BuyTable({ items }: { items: readonly BuyListItemDto[] }) {
  return (
    <Table aria-label="Tracks to buy">
      <TableHeader>
        <TableRow>
          <TableHead className="w-24 sm:w-32">Store</TableHead>
          <TableHead>Title</TableHead>
          <TableHead className="w-[38%] lg:w-72">Link</TableHead>
          <TableHead className="hidden w-48 lg:table-cell">Playlist</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.trackId} className="hover:bg-surface-2">
            <TableCell className="truncate text-warn" title={item.store}>
              {item.store}
            </TableCell>
            <TableCell>
              <div className="truncate leading-4 text-text" title={item.title}>
                {item.title}
              </div>
              <div className="truncate text-xs leading-4 text-text-muted" title={item.artist}>
                {item.artist}
              </div>
            </TableCell>
            <TableCell>
              <a
                href={safeHref(item.purchaseUrl)}
                target="_blank"
                rel="noopener noreferrer"
                title={item.purchaseUrl}
                className="block truncate font-mono text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {middleTruncate(displayUrl(item.purchaseUrl), 36)}
              </a>
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <Link
                href={`/playlists/${item.playlistId}`}
                title={item.playlistTitle}
                className="block truncate text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {item.playlistTitle}
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function BuyListView() {
  const { state, reload } = useApi("/api/buy-list", buyListResponseSchema);
  const items = state.status === "ok" ? state.data.items : [];

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-mono text-13 text-text-muted tabular-nums" aria-live="polite">
          {state.status === "ok" && `${items.length} ${items.length === 1 ? "track" : "tracks"}`}
        </p>
        <Button size="sm" disabled={items.length === 0} onClick={() => downloadCsv(items)}>
          <Download aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {state.status === "loading" && <RowsSkeleton rows={5} label="Loading the buy list" />}
      {state.status === "error" && (
        <ErrorState title="Could not load the buy list" error={state.error} onRetry={reload} />
      )}
      {state.status === "ok" &&
        (items.length === 0 ? (
          <EmptyState>
            No tracks to buy yet. They appear here once a playlist is classified.
          </EmptyState>
        ) : (
          <BuyTable items={items} />
        ))}
    </>
  );
}
