import { expect, test, type Page } from "@playwright/test";
import { ADDED, DETAIL, fakeApi, PLAYLIST_ID, PLAYLIST_URL, PLAYLISTS } from "./fixtures";

/** Fakes the ingest: POST /api/playlists answers as if the playlist had been stored. */
async function fakeIngest(page: Page, status: number, body: unknown): Promise<void> {
  await page.route("**/api/playlists", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
      : route.fallback(),
  );
}

async function addPlaylist(page: Page, url: string): Promise<void> {
  await page.goto("/playlists");
  await page.getByRole("button", { name: "Add playlist" }).click();
  const dialog = page.getByRole("dialog", { name: "Add playlist" });
  await dialog.getByLabel("Playlist URL").fill(url);
  await dialog.getByRole("button", { name: "Add playlist" }).click();
}

const trackRows = (page: Page) => page.getByRole("table", { name: "Tracks" }).locator("tbody tr");

test("paste a URL, see the classified tracks, filter and sort them", async ({ page }) => {
  await fakeApi(page, { detail: DETAIL });
  await fakeIngest(page, 201, ADDED);

  // Paste URL -> the playlist page with its tracks table.
  await addPlaylist(page, PLAYLIST_URL);
  await expect(page).toHaveURL(new RegExp(`/playlists/${PLAYLIST_ID}\\?skipped=1$`));
  await expect(page.getByRole("heading", { level: 1, name: "Fixture Crate" })).toBeVisible();
  await expect(page.getByText("SoundCloud API")).toBeVisible();
  await expect(page.getByText(/1 track in this playlist could not be read/)).toBeVisible();
  await expect(trackRows(page)).toHaveCount(6);
  await expect(trackRows(page).first()).toContainText("Native Download (Original Mix)");
  await expect(trackRows(page).first()).toContainText("Native");
  await expect(trackRows(page).nth(1)).toContainText("hypeddit");

  // Filter by classification.
  const filters = page.getByRole("group", { name: "Filter by classification" });
  await expect(filters.getByRole("button", { name: /^Gate/ })).toContainText("2");
  await filters.getByRole("button", { name: /^Gate/ }).click();
  await expect(filters.getByRole("button", { name: /^Gate/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(trackRows(page)).toHaveCount(2);
  await expect(trackRows(page).nth(0)).toContainText("Gated Bootleg");
  await expect(trackRows(page).nth(1)).toContainText("A Short Link Free DL");

  // Sort within the filter.
  const titleHeader = page.getByRole("columnheader", { name: "Title" });
  await titleHeader.getByRole("button").click();
  await expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(trackRows(page).first()).toContainText("A Short Link Free DL");
  await titleHeader.getByRole("button").click();
  await expect(titleHeader).toHaveAttribute("aria-sort", "descending");
  await expect(trackRows(page).first()).toContainText("Gated Bootleg");

  await filters.getByRole("button", { name: /^All/ }).click();
  await expect(trackRows(page)).toHaveCount(6);
});

test("the playlists page lists playlists and opens one", async ({ page }) => {
  await fakeApi(page, { playlists: PLAYLISTS, detail: DETAIL });
  await page.goto("/playlists");

  const row = page.getByRole("list", { name: "Playlists" }).getByRole("link");
  await expect(row).toContainText("Fixture Crate");
  await expect(row).toContainText("6 tracks");
  await row.click();

  await expect(page).toHaveURL(new RegExp(`/playlists/${PLAYLIST_ID}$`));
  await expect(trackRows(page)).toHaveCount(6);
});

test("the tracks table fits the viewport and a filter with no matches says so", async ({
  page,
}) => {
  const onlyNative = { ...DETAIL, tracks: DETAIL.tracks.slice(0, 1) };
  await fakeApi(page, { detail: onlyNative });
  await page.goto(`/playlists/${PLAYLIST_ID}`);
  await expect(trackRows(page)).toHaveCount(1);

  await page.getByRole("button", { name: /^Buy/ }).click();
  await expect(page.getByText(/No buy tracks in this playlist/)).toBeVisible();

  await fakeApi(page, { detail: DETAIL });
  await page.reload();
  await expect(trackRows(page)).toHaveCount(6);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a playlist read through the yt-dlp fallback says so", async ({ page }) => {
  await fakeApi(page, {
    detail: { ...DETAIL, playlist: { ...DETAIL.playlist, ingestSource: "yt_dlp" } },
  });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await expect(page.getByText("yt-dlp fallback")).toBeVisible();
  await expect(page.getByText(/was read with yt-dlp/)).toBeVisible();
});

test.describe("when ingest fails", () => {
  test.beforeEach(async ({ page }) => {
    await fakeApi(page);
  });

  test("a private or missing playlist shows an inline error and the dialog stays open", async ({
    page,
  }) => {
    await fakeIngest(page, 404, {
      error: {
        code: "playlist_not_found",
        message: "SoundCloud has no public playlist at that URL. It may be private or deleted.",
      },
    });
    await addPlaylist(page, PLAYLIST_URL);

    const dialog = page.getByRole("dialog", { name: "Add playlist" });
    await expect(dialog.getByRole("alert")).toHaveText(
      "SoundCloud has no public playlist at that URL. It may be private or deleted.",
    );
    await expect(dialog.getByLabel("Playlist URL")).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/playlists$/);
  });

  test("a URL that is not a playlist is rejected before anything is sent", async ({ page }) => {
    let posted = false;
    await page.route("**/api/playlists", (route) => {
      if (route.request().method() === "POST") posted = true;
      return route.fallback();
    });
    await addPlaylist(page, "https://soundcloud.com/some-artist/one-track");

    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "Enter a SoundCloud playlist URL",
    );
    expect(posted).toBe(false);
  });
});

test.describe("error states", () => {
  // The e2e server points at a Postgres that does not exist, so the real routes answer
  // with their typed 500.
  test("the playlists page explains a failed load and offers a retry", async ({ page }) => {
    await page.goto("/playlists");

    const alert = page.getByRole("alert").filter({ hasText: "Could not load the playlists" });
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText("Check that Postgres is running");

    await fakeApi(page, { playlists: PLAYLISTS });
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("list", { name: "Playlists" })).toContainText("Fixture Crate");
  });

  test("an unknown playlist says it is not in Gatecrusher", async ({ page }) => {
    await page.route(`**/api/playlists/${PLAYLIST_ID}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found", message: "No such playlist." } }),
      }),
    );
    await page.goto(`/playlists/${PLAYLIST_ID}`);

    const alert = page
      .getByRole("alert")
      .filter({ hasText: "This playlist is not in Gatecrusher" });
    await expect(alert).toContainText("No such playlist.");
    await expect(page.getByRole("link", { name: "Playlists" }).first()).toBeVisible();
  });
});
