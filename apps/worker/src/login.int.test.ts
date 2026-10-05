import {
  guardNetwork,
  NATIVE_FIXTURES_DIR,
  startFixtureServer,
  type FixtureServer,
  type NetworkGuard,
} from "@gatecrusher/gates/testing";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runLogin } from "./login.ts";

// The login script's logic against fixture pages: "signed-out" stands in for the
// sign-in page (the test plays the human with window.__signIn()), "track" for a page
// that shows the signed-in header on a fresh load.
let server: FixtureServer;
let browser: Browser;
let context: BrowserContext;
let guard: NetworkGuard;

beforeAll(async () => {
  server = await startFixtureServer({ fixturesDir: NATIVE_FIXTURES_DIR });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  guard = await guardNetwork(context);
});

afterEach(async () => {
  await context.close();
  expect(guard.violations).toEqual([]);
});

function login(overrides: Partial<Parameters<typeof runLogin>[0]> = {}) {
  return runLogin({
    context,
    signInUrl: server.pageUrl("signed-out"),
    homeUrl: server.pageUrl("track"),
    pollMs: 20,
    // Generous: the whole worker suite runs browsers in parallel on one machine.
    timeoutMs: 25_000,
    ...overrides,
  });
}

describe("runLogin", () => {
  it("opens the sign-in page, waits for the human, then confirms the session", async () => {
    let waiting = false;
    const pending = login({
      onWaiting: () => {
        waiting = true;
      },
    });

    await expect.poll(() => waiting).toBe(true);
    const [page] = context.pages();
    if (page === undefined) throw new Error("the sign-in page was not opened");
    expect(page.url()).toBe(server.pageUrl("signed-out"));

    // The human signs in.
    await page.evaluate(() => (window as unknown as { __signIn(): void }).__signIn());

    expect(await pending).toEqual({ ok: true });
    // Confirmed on a fresh load of another page, not on the one that just changed.
    expect(page.url()).toBe(server.pageUrl("track"));
  });

  it("finishes straight away when the profile is already signed in", async () => {
    expect(await login({ signInUrl: server.pageUrl("track") })).toEqual({ ok: true });
  });

  it("gives up after the timeout if nobody signs in", async () => {
    expect(await login({ timeoutMs: 150 })).toMatchObject({ ok: false, kind: "timed_out" });
  });

  it("reports the window being closed", async () => {
    let waiting = false;
    const pending = login({
      onWaiting: () => {
        waiting = true;
      },
    });
    await expect.poll(() => waiting).toBe(true);

    await context.close();

    expect(await pending).toMatchObject({ ok: false, kind: "window_closed" });
  });

  it("does not report success when the session does not hold after a reload", async () => {
    const pending = login({ homeUrl: server.pageUrl("signed-out"), confirmTimeoutMs: 200 });
    await expect.poll(() => context.pages()[0]?.url()).toBe(server.pageUrl("signed-out"));
    const [page] = context.pages();
    await page?.evaluate(() => (window as unknown as { __signIn(): void }).__signIn());

    expect(await pending).toMatchObject({ ok: false, kind: "not_confirmed" });
  });
});
