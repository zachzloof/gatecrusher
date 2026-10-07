import { expect, test } from "@playwright/test";
import type { TrackDto } from "../lib/api-schemas";
import { DETAIL, fakeApi, PLAYLIST_ID, TRACKS } from "./fixtures";

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

test("ticking tracks limits the zip to them; nothing ticked means everything", async ({ page }) => {
  const [first, second] = TRACKS;
  if (first === undefined || second === undefined) throw new Error("fixture playlist is short");
  const file = { fileName: "x.mp3", sizeBytes: 1_000_000, kind: "audio" } as const;
  const done = {
    status: "SUCCEEDED",
    stepName: null,
    needsHuman: null,
    manual: null,
    error: null,
  } as const;
  const tracks: TrackDto[] = [
    { ...first, job: done, download: file },
    { ...second, job: done, download: file },
    ...TRACKS.slice(2),
  ];
  await fakeApi(page, { detail: { ...DETAIL, tracks } });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await expect(page.getByRole("link", { name: /Download zip/ })).toContainText("2 files");

  // Tick one downloaded track: the zip is a form naming just it.
  await page.getByRole("checkbox", { name: `Select ${second.title}` }).check();
  const zip = page.getByRole("button", { name: /Download zip/ });
  await expect(zip).toContainText("1 ticked file, 1.0 MB");
  await expect(page.locator('form[action$="/archive"] input[name="tracks"]')).toHaveValue(
    second.id,
  );
  await expect(page.getByRole("link", { name: /Download zip/ })).toHaveCount(0);

  // Tick a track with no file: it cannot add anything.
  await page.getByRole("checkbox", { name: `Select ${second.title}` }).uncheck();
  await page.getByRole("checkbox", { name: "Select Stream Only" }).check();
  await expect(page.getByRole("button", { name: /nothing ticked is downloaded/ })).toBeDisabled();

  // Select all, then clear: back to the plain link.
  const all = page.getByRole("checkbox", { name: "Select all shown tracks" });
  await all.check();
  await expect(page.locator('form[action$="/archive"] input[name="tracks"]')).toHaveValue(
    `${first.id},${second.id}`,
  );
  await all.uncheck();
  await expect(page.getByRole("link", { name: /Download zip/ })).toHaveAttribute(
    "href",
    `/api/playlists/${PLAYLIST_ID}/archive`,
  );
});

test("the zip button is disabled until something has been downloaded", async ({ page }) => {
  await fakeApi(page, { detail: DETAIL });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await expect(page.getByRole("button", { name: "Download zip" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /Download zip/ })).toHaveCount(0);
});

test("inside the desktop app, Open folder opens the playlist's downloads folder", async ({
  page,
}) => {
  // What the desktop app's preload puts on the page, recording what it is asked.
  await page.addInitScript(() => {
    const opened: (string | undefined)[] = [];
    Object.assign(window, {
      gatecrusherDesktop: {
        openDownloads: (folder?: string) => {
          opened.push(folder);
          return Promise.resolve();
        },
      },
      openedFolders: opened,
    });
  });
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

  await page.getByRole("button", { name: "Open folder" }).click();

  // The folder is the playlist's slug from its SoundCloud URL, never a path.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { openedFolders: unknown[] }).openedFolders),
    )
    .toEqual(["fixture-crate"]);
});

test("in a browser there is no Open folder button", async ({ page }) => {
  await fakeApi(page, { detail: DETAIL });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await expect(page.getByRole("button", { name: /Download tracks/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open folder" })).toHaveCount(0);
});
