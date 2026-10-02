import { expect, test } from "@playwright/test";
import { E2E_DATABASE_URL } from "./constants";
import { fakeApi } from "./fixtures";

const PAGES = [
  { link: "Playlists", path: "/playlists", heading: "Playlists", empty: /No playlists yet/ },
  { link: "Runs", path: "/runs", heading: "Runs", empty: /No runs yet/ },
  { link: "Buy list", path: "/buy-list", heading: "Buy list", empty: /No tracks to buy yet/ },
  { link: "Manual list", path: "/manual-list", heading: "Manual list", empty: /Nothing here/ },
  { link: "Evals", path: "/evals", heading: "Evals", empty: /No data yet/ },
  { link: "Settings", path: "/settings", heading: "Settings", empty: /DATABASE_URL/ },
] as const;

// The e2e server has no database, so the data routes are answered as "nothing yet".
test.beforeEach(async ({ page }) => {
  await fakeApi(page);
});

test("the shell loads on the playlists page", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/playlists$/);
  await expect(page).toHaveTitle("Playlists — Gatecrusher");
  await expect(page.getByRole("heading", { level: 1, name: "Playlists" })).toBeVisible();
  await expect(page.getByText(/No playlists yet/)).toBeVisible();
});

test("the nav reaches every section and each shows its empty state", async ({ page }) => {
  await page.goto("/playlists");
  const nav = page.getByRole("navigation", { name: "Main" });

  for (const target of PAGES) {
    await nav.getByRole("link", { name: target.link, exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${target.path}$`));
    await expect(page.getByRole("heading", { level: 1, name: target.heading })).toBeVisible();
    await expect(page.getByText(target.empty).first()).toBeVisible();
    await expect(nav.getByRole("link", { name: target.link, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});

test("no page scrolls horizontally", async ({ page }) => {
  for (const target of PAGES) {
    await page.goto(target.path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${target.path} overflows horizontally`).toBeLessThanOrEqual(0);
  }
});

test("the runs page has a Needs-you section", async ({ page }) => {
  await page.goto("/runs");

  await expect(page.getByRole("heading", { level: 2, name: "Needs you" })).toBeVisible();
  await expect(page.getByText(/Nothing is waiting on you/)).toBeVisible();
});

test("a banner says so when a service is down, and the shell stays usable", async ({ page }) => {
  await page.goto("/playlists");

  // The e2e server points at a Postgres that does not exist.
  const banner = page.getByRole("status").filter({ hasText: "Postgres" });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText("unreachable");
  await expect(banner).toContainText("docker compose up -d");
  await expect(page.getByRole("button", { name: "Add playlist" })).toBeEnabled();
});

test.describe("add playlist dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/playlists");
    await page.getByRole("button", { name: "Add playlist" }).click();
  });

  test("rejects a URL that is not a SoundCloud playlist", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Add playlist" });
    await dialog.getByLabel("Playlist URL").fill("https://example.com/not-soundcloud");
    await dialog.getByRole("button", { name: "Add playlist" }).click();

    await expect(dialog.getByRole("alert")).toContainText("Enter a SoundCloud playlist URL");
    await expect(dialog.getByLabel("Playlist URL")).toHaveAttribute("aria-invalid", "true");
  });

  test("shows the server's error when the API rejects the request", async ({ page }) => {
    await page.route("**/api/playlists", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "invalid_request", message: "Rejected by test" } }),
      }),
    );
    const dialog = page.getByRole("dialog", { name: "Add playlist" });
    await dialog.getByLabel("Playlist URL").fill("https://soundcloud.com/some-artist/sets/digs");
    await dialog.getByRole("button", { name: "Add playlist" }).click();

    await expect(dialog.getByRole("alert")).toHaveText("Rejected by test");
  });
});

test("settings shows which variables are set and never their values", async ({ page }) => {
  await page.goto("/settings");

  const row = page.getByRole("listitem").filter({ hasText: "DATABASE_URL" });
  await expect(row).toContainText("Set");
  const optional = page.getByRole("listitem").filter({ hasText: "ANTHROPIC_API_KEY" });
  await expect(optional).toContainText(/Set|Not set/);

  const html = await page.content();
  const { password, username } = new URL(E2E_DATABASE_URL);
  expect(html).not.toContain(E2E_DATABASE_URL);
  expect(html).not.toContain(password);
  expect(html).not.toContain(username);
});
