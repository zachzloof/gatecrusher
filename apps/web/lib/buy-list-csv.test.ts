import { describe, expect, it } from "vitest";
import type { BuyListItemDto } from "./api-schemas";
import { buyListCsv, buyListCsvFilename } from "./buy-list-csv";

const item: BuyListItemDto = {
  trackId: "00000000-0000-4000-8000-000000000001",
  store: "Bandcamp",
  title: 'Night "Drive", Pt. 2',
  artist: "=Fixture, The",
  purchaseUrl: "https://fixture-label.bandcamp.com/track/night-drive?a=1,2",
  permalinkUrl: "https://soundcloud.com/fixture-artist/night-drive",
  playlistId: "00000000-0000-4000-8000-000000000002",
  playlistTitle: "Fixture Crate",
};

describe("buyListCsv", () => {
  it("writes a header row and one escaped row per track", () => {
    expect(buyListCsv([item])).toBe(
      [
        "Store,Title,Artist,Link,Playlist,SoundCloud",
        'Bandcamp,"Night ""Drive"", Pt. 2","\'=Fixture, The","https://fixture-label.bandcamp.com/track/night-drive?a=1,2",Fixture Crate,https://soundcloud.com/fixture-artist/night-drive',
        "",
      ].join("\r\n"),
    );
  });

  it("is only the header for an empty list", () => {
    expect(buyListCsv([])).toBe("Store,Title,Artist,Link,Playlist,SoundCloud\r\n");
  });
});

describe("buyListCsvFilename", () => {
  it("carries the date", () => {
    expect(buyListCsvFilename(new Date("2026-10-01T23:30:00Z"))).toBe(
      "gatecrusher-buy-list-2026-10-01.csv",
    );
  });
});
