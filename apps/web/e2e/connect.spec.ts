import { expect, test, type Page, type Route } from "@playwright/test";
import type { SoundcloudAccountResponse } from "../lib/api-schemas";
import { CONNECTED, DETAIL, fakeApi, PLAYLIST_ID } from "./fixtures";

// The SoundCloud account route is faked at the network boundary: no database, and
// SoundCloud is never asked about the token. The token is made up.
const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * Answers GET with the current state and PUT/DELETE as the given handlers say, keeping
 * the state in step like the real route. Returns the bodies the page sent.
 */
async function fakeAccount(
  page: Page,
  initial: SoundcloudAccountResponse,
  answers: { put?: (route: Route) => Promise<void> } = {},
): Promise<{ sent: () => unknown[] }> {
  let current = initial;
  const sent: unknown[] = [];
  await page.route("**/api/soundcloud-account", async (route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill(json(200, current));
    if (method === "DELETE") {
      current = { connected: false };
      return route.fulfill(json(200, current));
    }
    sent.push(route.request().postDataJSON());
    if (answers.put !== undefined) return answers.put(route);
    current = CONNECTED;
    return route.fulfill(json(200, current));
  });
  return { sent: () => sent };
}

const tokenField = (page: Page) => page.getByLabel("oauth_token value");

test.beforeEach(async ({ page }) => {
  await fakeApi(page);
});

test("the connect screen walks through finding the token before asking for it", async ({
  page,
}) => {
  await fakeAccount(page, { connected: false });
  await page.goto("/connect");

  await expect(page).toHaveTitle("Connect SoundCloud — Gatecrusher");
  await expect(page.getByRole("heading", { level: 1, name: "Connect SoundCloud" })).toBeVisible();
  await expect(page.getByText("Use a burner account.")).toBeVisible();
  const steps = page.getByRole("region", { name: "Find your oauth_token" }).getByRole("listitem");
  await expect(steps).toHaveCount(6);
  await expect(steps.nth(2)).toContainText("Application");
  await expect(page.getByRole("figure")).toContainText("oauth_token");

  // Firefox and Safari steps are there, folded away.
  await page.getByText("Using Firefox?").click();
  await expect(page.getByText(/Press F12 and open the Storage tab/)).toBeVisible();

  // The form comes after the tutorial, and keeps what is pasted off the screen.
  const tutorialBottom = await page
    .getByRole("heading", { name: "If it doesn't work" })
    .boundingBox();
  const fieldTop = await tokenField(page).boundingBox();
  expect(fieldTop?.y ?? 0).toBeGreaterThan(tutorialBottom?.y ?? Infinity);
  await expect(tokenField(page)).toHaveAttribute("type", "password");
});

test("pasting a token connects the account", async ({ page }) => {
  const account = await fakeAccount(page, { connected: false });
  await page.goto("/connect");

  await tokenField(page).fill(`oauth_token=${TOKEN}`);
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByText("Connected as burner-digger.")).toBeVisible();
  // Sent once, already trimmed down to the value.
  expect(account.sent()).toEqual([{ token: TOKEN }]);
  await expect(tokenField(page)).toHaveCount(0);
  await expect(page.getByLabel(/Replace the token/)).toHaveValue("");

  await page.getByRole("link", { name: "Go to playlists" }).click();
  await expect(page).toHaveURL(/\/playlists$/);
});

test("a value that is not a token is refused before anything is sent", async ({ page }) => {
  const account = await fakeAccount(page, { connected: false });
  await page.goto("/connect");

  await tokenField(page).fill("sc_anonymous_id=123; oauth_token=abc");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByText(/doesn't look like an oauth_token value/)).toHaveRole("alert");
  expect(account.sent()).toEqual([]);
});

test("a token SoundCloud refuses says what to check, and nothing is connected", async ({
  page,
}) => {
  await fakeAccount(
    page,
    { connected: false },
    {
      put: (route) =>
        route.fulfill(
          json(422, {
            error: {
              code: "soundcloud_token_rejected",
              message:
                "SoundCloud did not accept that token. Check you copied the whole oauth_token value while signed in, then try again.",
            },
          }),
        ),
    },
  );
  await page.goto("/connect");

  await tokenField(page).fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByText(/SoundCloud did not accept that token\. Check/)).toHaveRole("alert");
  await expect(page.getByRole("link", { name: "Skip for now" })).toBeVisible();
});

test("skip for now goes to the playlists", async ({ page }) => {
  await fakeAccount(page, { connected: false });
  await page.goto("/connect");

  await page.getByRole("link", { name: "Skip for now" }).click();

  await expect(page).toHaveURL(/\/playlists$/);
});

test("settings shows the account and disconnects it after confirming", async ({ page }) => {
  await fakeAccount(page, CONNECTED);
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "SoundCloud account" });

  await expect(panel).toContainText("Connected as burner-digger");
  await panel.getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect burner-digger?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Disconnect" }).click();

  await expect(dialog).toBeHidden();
  await expect(panel).toContainText("Not connected");
  await panel.getByRole("link", { name: "Connect SoundCloud" }).click();
  await expect(page).toHaveURL(/\/connect$/);
});

test("downloading without an account says so and links to the connect screen", async ({ page }) => {
  await fakeApi(page, { detail: DETAIL });
  await page.route(`**/api/playlists/${PLAYLIST_ID}/runs`, (route) =>
    route.fulfill(
      json(409, {
        error: {
          code: "soundcloud_not_connected",
          message:
            "Connect a SoundCloud account first: SoundCloud only hands an uploader's file to a signed-in account.",
        },
      }),
    ),
  );
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await page.getByRole("button", { name: "Download tracks" }).click();

  const bar = page.getByRole("region", { name: "Downloads" });
  await expect(bar).toContainText("Connect a SoundCloud account first");
  await bar.getByRole("link", { name: "Connect SoundCloud" }).click();
  await expect(page).toHaveURL(/\/connect$/);
});

test("the connect screen does not scroll horizontally", async ({ page }) => {
  await fakeAccount(page, { connected: false });
  await page.goto("/connect");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
