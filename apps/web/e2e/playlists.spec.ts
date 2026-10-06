import { expect, test, type Page } from "@playwright/test";
import { fakeApi, PLAYLIST_ID, PLAYLISTS } from "./fixtures";

/** Answers DELETE on the fixture playlist, and lists nothing once it succeeded. */
async function fakeDelete(page: Page, status: number, body: unknown): Promise<void> {
  let deleted = false;
  await page.route(`**/api/playlists/${PLAYLIST_ID}`, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleted = status === 200;
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/playlists", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(deleted ? { playlists: [] } : PLAYLISTS),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await fakeApi(page, { playlists: PLAYLISTS });
});

test("deleting a playlist says what it removes, asks first, then removes it", async ({ page }) => {
  await fakeDelete(page, 200, { deletedFiles: 1, freedBytes: 8_912_896 });
  await page.goto("/playlists");

  await page.getByRole("button", { name: "Delete Fixture Crate" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete Fixture Crate?");
  await expect(dialog).toContainText("1 downloaded file (8.9 MB)");

  // Keeping it changes nothing.
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("list", { name: "Playlists" })).toContainText("Fixture Crate");

  await page.getByRole("button", { name: "Delete Fixture Crate" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete playlist" }).click();

  await expect(page.getByText("Deleted Fixture Crate and its 1 file (8.9 MB).")).toBeVisible();
  await expect(page.getByText(/No playlists yet/)).toBeVisible();
});

test("a playlist that is downloading cannot be deleted, and the dialog says why", async ({
  page,
}) => {
  await fakeDelete(page, 409, {
    error: {
      code: "playlist_busy",
      message:
        "A track from this playlist is downloading right now. Open the playlist, click Cancel, wait for that track to finish, then delete it.",
    },
  });
  await page.goto("/playlists");

  await page.getByRole("button", { name: "Delete Fixture Crate" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete playlist" }).click();

  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("click Cancel");
  await page.getByRole("dialog").getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByRole("list", { name: "Playlists" })).toContainText("Fixture Crate");
});
