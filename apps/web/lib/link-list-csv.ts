import { toCsv } from "@gatecrusher/core";
import type { BuyListItemDto, GateListItemDto } from "./api-schemas";

/** One row of the buy list or the gate list, as the shared table and CSV see it. */
export interface LinkListItem {
  trackId: string;
  /** The store, or the gate platform. */
  source: string;
  title: string;
  artist: string;
  url: string;
  permalinkUrl: string;
  playlistId: string;
  playlistTitle: string;
}

export function buyItemToLink(item: BuyListItemDto): LinkListItem {
  return { ...item, source: item.store, url: item.purchaseUrl };
}

export function gateItemToLink(item: GateListItemDto): LinkListItem {
  return { ...item, source: item.platform, url: item.gateUrl };
}

/** The list as CSV text, one row per track, in the order given. */
export function linkListCsv(sourceHeader: string, items: readonly LinkListItem[]): string {
  return toCsv(
    [sourceHeader, "Title", "Artist", "Link", "Playlist", "SoundCloud"],
    items.map((item) => [
      item.source,
      item.title,
      item.artist,
      item.url,
      item.playlistTitle,
      item.permalinkUrl,
    ]),
  );
}

export function linkListCsvFilename(list: "buy-list" | "gate-list", now: Date): string {
  return `gatecrusher-${list}-${now.toISOString().slice(0, 10)}.csv`;
}
