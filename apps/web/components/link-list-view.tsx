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
import { displayUrl, middleTruncate, safeHref } from "@/lib/format";
import type { LinkListItem } from "@/lib/link-list-csv";
import type { ApiFailure, ApiState } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/** Hands the browser a CSV file to save. The BOM makes Excel read it as UTF-8. */
function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked a moment later, so the browser has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

interface LinkListViewProps {
  state: ApiState<readonly LinkListItem[]>;
  onRetry: () => void;
  /** Accessible name of the table: "Tracks to buy". */
  tableLabel: string;
  /** Header of the first column: "Store" or "Gate". */
  sourceLabel: string;
  sourceClassName: string;
  loadingLabel: string;
  errorTitle: string;
  empty: string;
  csv: (items: readonly LinkListItem[]) => { text: string; filename: string };
}

function LinkTable({
  items,
  tableLabel,
  sourceLabel,
  sourceClassName,
}: Pick<LinkListViewProps, "tableLabel" | "sourceLabel" | "sourceClassName"> & {
  items: readonly LinkListItem[];
}) {
  return (
    <Table aria-label={tableLabel}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24 sm:w-32">{sourceLabel}</TableHead>
          <TableHead>Title</TableHead>
          <TableHead className="w-[38%] lg:w-72">Link</TableHead>
          <TableHead className="hidden w-48 lg:table-cell">Playlist</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.trackId} className="hover:bg-surface-2">
            <TableCell className={cn("truncate", sourceClassName)} title={item.source}>
              {item.source}
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
                href={safeHref(item.url)}
                target="_blank"
                rel="noopener noreferrer"
                title={item.url}
                className="block truncate font-mono text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {middleTruncate(displayUrl(item.url), 36)}
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

/** A list of tracks with a link each, exportable as CSV: the buy list and the gate list. */
export function LinkListView(props: LinkListViewProps) {
  const { state, onRetry, csv } = props;
  const items = state.status === "ok" ? state.data : [];
  const error: ApiFailure | null = state.status === "error" ? state.error : null;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-mono text-13 text-text-muted tabular-nums" aria-live="polite">
          {state.status === "ok" && `${items.length} ${items.length === 1 ? "track" : "tracks"}`}
        </p>
        <Button
          size="sm"
          disabled={items.length === 0}
          onClick={() => {
            const file = csv(items);
            downloadCsv(file.text, file.filename);
          }}
        >
          <Download aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {state.status === "loading" && <RowsSkeleton rows={5} label={props.loadingLabel} />}
      {error !== null && <ErrorState title={props.errorTitle} error={error} onRetry={onRetry} />}
      {state.status === "ok" &&
        (items.length === 0 ? (
          <EmptyState>{props.empty}</EmptyState>
        ) : (
          <LinkTable
            items={items}
            tableLabel={props.tableLabel}
            sourceLabel={props.sourceLabel}
            sourceClassName={props.sourceClassName}
          />
        ))}
    </>
  );
}
