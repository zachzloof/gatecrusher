import { describe, expect, it } from "vitest";
import type { BuyListItemDto, GateListItemDto } from "./api-schemas";
import { buyItemToLink, gateItemToLink, linkListCsv, linkListCsvFilename } from "./link-list-csv";

const buy: BuyListItemDto = {
  trackId: "00000000-0000-4000-8000-000000000001",
  store: "Bandcamp",
  title: 'Night "Drive", Pt. 2',
  artist: "=Fixture, The",
  purchaseUrl: "https://fixture-label.bandcamp.com/track/night-drive?a=1,2",
  permalinkUrl: "https://soundcloud.com/fixture-artist/night-drive",
  playlistId: "00000000-0000-4000-8000-000000000002",
  playlistTitle: "Fixture Crate",
};

const gate: GateListItemDto = {
  trackId: "00000000-0000-4000-8000-000000000003",
  platform: "hypeddit",
  title: "Gated Bootleg",
  artist: "Fixture Artist",
  gateUrl: "https://hypeddit.com/track/fixture1",
  permalinkUrl: "https://soundcloud.com/fixture-artist/track-1",
  playlistId: "00000000-0000-4000-8000-000000000002",
  playlistTitle: "Fixture Crate",
};

describe("linkListCsv", () => {
  it("writes a header row and one escaped row per track", () => {
    expect(linkListCsv("Store", [buyItemToLink(buy)])).toBe(
      [
        "Store,Title,Artist,Link,Playlist,SoundCloud",
        'Bandcamp,"Night ""Drive"", Pt. 2","\'=Fixture, The","https://fixture-label.bandcamp.com/track/night-drive?a=1,2",Fixture Crate,https://soundcloud.com/fixture-artist/night-drive',
        "",
      ].join("\r\n"),
    );
  });

  it("lists gate tracks by platform", () => {
    expect(linkListCsv("Gate", [gateItemToLink(gate)])).toBe(
      [
        "Gate,Title,Artist,Link,Playlist,SoundCloud",
        "hypeddit,Gated Bootleg,Fixture Artist,https://hypeddit.com/track/fixture1,Fixture Crate,https://soundcloud.com/fixture-artist/track-1",
        "",
      ].join("\r\n"),
    );
  });

  it("is only the header for an empty list", () => {
    expect(linkListCsv("Store", [])).toBe("Store,Title,Artist,Link,Playlist,SoundCloud\r\n");
  });
});

describe("linkListCsvFilename", () => {
  it("names the file by list and day", () => {
    const day = new Date("2026-10-05T23:59:00.000Z");

    expect(linkListCsvFilename("buy-list", day)).toBe("gatecrusher-buy-list-2026-10-05.csv");
    expect(linkListCsvFilename("gate-list", day)).toBe("gatecrusher-gate-list-2026-10-05.csv");
  });
});
