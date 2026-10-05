import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { TrackDto } from "../lib/api-schemas";
import { DETAIL, fakeApi, GATE_LIST, PLAYLIST_ID, TRACKS } from "./fixtures";

test("the manual list shows gate tracks with their links and exports them", async ({ page }) => {
  await fakeApi(page, { gateList: GATE_LIST });
  await page.goto("/manual-list");

  const rows = page.getByRole("table", { name: "Gate tracks" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("hypeddit");
  await expect(rows.first()).toContainText("Gated Bootleg");
  await expect(rows.first().getByRole("link").first()).toHaveAttribute(
    "href",
    "https://hypeddit.com/track/fixture1",
  );
  await expect(rows.nth(1)).toContainText("unknown");
  await expect(page.getByText(/automating gates is paused/i)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^gatecrusher-gate-list-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain("Gate,Title,Artist,Link,Playlist,SoundCloud");
  expect(csv).toContain(
    "hypeddit,Gated Bootleg,Fixture Artist,https://hypeddit.com/track/fixture1",
  );
});

test("a playlist with downloaded files offers them as one zip", async ({ page }) => {
  const first = TRACKS[0];
  if (first === undefined) throw new Error("fixture playlist is empty");
  const downloaded: TrackDto = {
    ...first,
    job: { status: "SUCCEEDED", stepName: null, needsHuman: null, manual: null, error: null },
    download: {
      fileName: "Fixture Artist - Native Download.mp3",
      sizeBytes: 9_400_000,
      kind: "audio",
    },
  };
  await fakeApi(page, { detail: { ...DETAIL, tracks: [downloaded, ...TRACKS.slice(1)] } });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  // The archive itself is covered by the route handler tests; here, the page offers it.
  const zipLink = page.getByRole("link", { name: /Download zip/ });
  await expect(zipLink).toContainText("1 file, 9.4 MB");
  await expect(zipLink).toHaveAttribute("href", `/api/playlists/${PLAYLIST_ID}/archive`);
  await expect(zipLink).toHaveAttribute("download", "");
});

test("the zip button is disabled until something has been downloaded", async ({ page }) => {
  await fakeApi(page, { detail: DETAIL });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await expect(page.getByRole("button", { name: "Download zip" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /Download zip/ })).toHaveCount(0);
});
