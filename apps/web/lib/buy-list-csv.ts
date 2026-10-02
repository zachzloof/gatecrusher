import { toCsv } from "@gatecrusher/core";
import type { BuyListItemDto } from "./api-schemas";

export const BUY_LIST_CSV_HEADERS = ["Store", "Title", "Artist", "Link", "Playlist", "SoundCloud"];

/** The buy list as CSV text, one row per track, in the order given. */
export function buyListCsv(items: readonly BuyListItemDto[]): string {
  return toCsv(
    BUY_LIST_CSV_HEADERS,
    items.map((item) => [
      item.store,
      item.title,
      item.artist,
      item.purchaseUrl,
      item.playlistTitle,
      item.permalinkUrl,
    ]),
  );
}

export function buyListCsvFilename(now: Date): string {
  return `gatecrusher-buy-list-${now.toISOString().slice(0, 10)}.csv`;
}
