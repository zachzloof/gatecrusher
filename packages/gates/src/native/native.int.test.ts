import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAdapterHarness,
  NATIVE_FIXTURE_STATUSES,
  NATIVE_FIXTURES_DIR,
  nativeFixtureFiles,
  startFixtureServer,
  type AdapterHarness,
  type FixtureServer,
} from "../testing/index.ts";
import { createNativeAdapter } from "./adapter.ts";

// The real adapter, step runner, download store and verification against local fixture
// pages in a headless browser. Nothing here reaches SoundCloud.
const adapter = createNativeAdapter({ hosts: ["127.0.0.1"] });

let server: FixtureServer;
let harness: AdapterHarness;
let page: Page;

beforeAll(async () => {
  server = await startFixtureServer({
    fixturesDir: NATIVE_FIXTURES_DIR,
    files: nativeFixtureFiles(),
    statuses: NATIVE_FIXTURE_STATUSES,
  });
  harness = await createAdapterHarness();
});

afterAll(async () => {
  await harness.close();
  await server.close();
});

beforeEach(async () => {
  await rm(path.join(harness.dataDir, "downloads"), { recursive: true, force: true });
  page = await harness.newPage();
});

afterEach(async () => {
  await page.close();
  expect(harness.guard.violations).toEqual([]);
});

interface Clicks {
  more?: number;
  download?: number;
  purchase?: number;
}

const clicks = (target: Page = page) =>
  target.evaluate(() => (window as unknown as { __clicks: Clicks }).__clicks);

async function savedFiles(): Promise<string[]> {
  try {
    return await readdir(path.join(harness.dataDir, "downloads", "fixture-crate"));
  } catch {
    // The directory only exists once a download was captured.
    return [];
  }
}

const run = (name: string, query?: Record<string, string>) =>
  harness.run({ adapter, page, gateUrl: server.pageUrl(name, query) });

describe("native adapter: happy path", () => {
  it("opens the track, opens More, downloads and verifies the file", async () => {
    const { outcome, started, reports } = await run("track");

    expect(started).toEqual(["open-track", "open-more", "download"]);
    expect(reports.map((report) => report.outcome)).toEqual(["next", "next", "done"]);
    expect(outcome.result).toMatchObject({
      ok: true,
      download: {
        path: "downloads/fixture-crate/Fixture Artist - Fixture Track.mp3",
        mimeType: "audio/mpeg",
        kind: "audio",
      },
    });
    if (!outcome.result.ok) return;
    const saved = await stat(path.join(harness.dataDir, outcome.result.download.path));
    expect(saved.size).toBe(outcome.result.download.sizeBytes);
    expect(saved.size).toBeGreaterThan(1_048_576);
    expect(await savedFiles()).toEqual(["Fixture Artist - Fixture Track.mp3"]);
  });

  it("paces itself: reads after navigating, and waits before each click", async () => {
    const { delays } = await run("track");

    expect(delays).toEqual(["read", "between-steps", "action", "between-steps", "action"]);
  });

  it("saves a screenshot for every step", async () => {
    const { reports } = await run("track");

    expect(reports.map((report) => report.screenshotPath)).toEqual([
      expect.stringMatching(/^screenshots\/[0-9a-f-]+\/[0-9a-f-]+\/\d{4}-open-track\.png$/),
      expect.stringMatching(/\d{4}-open-more\.png$/),
      expect.stringMatching(/\d{4}-download\.png$/),
    ]);
    for (const report of reports) {
      const shot = await stat(path.join(harness.dataDir, report.screenshotPath ?? "missing"));
      expect(shot.size).toBeGreaterThan(0);
    }
  });

  it("clicks More and Download once each and never the purchase link", async () => {
    await run("track");

    expect(await clicks()).toEqual({ more: 1, download: 1, purchase: 0 });
  });

  it("keeps a second file with the same name, numbered", async () => {
    await run("track");
    const second = await harness.newPage();
    try {
      const { outcome } = await harness.run({
        adapter,
        page: second,
        gateUrl: server.pageUrl("track"),
      });
      expect(outcome.result.ok).toBe(true);
    } finally {
      await second.close();
    }

    expect((await savedFiles()).sort()).toEqual([
      "Fixture Artist - Fixture Track (2).mp3",
      "Fixture Artist - Fixture Track.mp3",
    ]);
  });

  it("keeps a zip that contains audio as delivered, recorded as an archive", async () => {
    const { outcome } = await run("track", { file: "zip-audio" });

    expect(outcome.result).toMatchObject({
      ok: true,
      download: {
        path: "downloads/fixture-crate/Fixture Artist - Fixture Track.zip",
        mimeType: "application/zip",
        kind: "archive",
      },
    });
    expect(await savedFiles()).toEqual(["Fixture Artist - Fixture Track.zip"]);
  });
});

describe("native adapter: downloads that must not count", () => {
  it.each([
    ["a tiny file", "tiny", /below the 1048576-byte minimum/],
    ["an HTML page served as audio/mpeg", "html", /an HTML page/],
    ["a zip with no audio in it", "zip-no-audio", /no audio file/],
  ])("does not accept %s, and leaves nothing behind", async (_label, file, reason) => {
    const { outcome } = await run("track", { file });

    expect(outcome.result).toMatchObject({
      ok: false,
      kind: "needs_human",
      reason: "unexpected_page",
      stepName: "download",
    });
    expect(
      !outcome.result.ok && "description" in outcome.result && outcome.result.description,
    ).toMatch(reason);
    expect(await savedFiles()).toEqual([]);
  });
});

describe("native adapter: blockers", () => {
  it("parks on a captcha that appears mid-flow, at the step it appeared after", async () => {
    const { outcome, started, reports } = await run("captcha");

    expect(outcome.result).toMatchObject({
      ok: false,
      kind: "needs_human",
      reason: "captcha",
      stepIndex: 1,
      stepName: "open-more",
    });
    expect(started).toEqual(["open-track", "open-more"]);
    expect(reports.at(-1)).toMatchObject({ outcome: "needs_human", checkpoint: null });
    const shot = await stat(path.join(harness.dataDir, outcome.screenshotPath ?? "missing"));
    expect(shot.size).toBeGreaterThan(0);
    // The challenge is still there, untouched, and nothing was downloaded.
    expect(await page.locator("iframe").count()).toBe(1);
    expect(await clicks()).toEqual({ more: 1, download: 0 });
  });

  it("resumes from the same step once the human has solved it, without redoing earlier steps", async () => {
    const gateUrl = server.pageUrl("captcha");
    const pageHits = server.hits("/fixture-artist/captcha");
    await harness.run({ adapter, page, gateUrl });

    await page.evaluate(() => (window as unknown as { __solveCaptcha(): void }).__solveCaptcha());
    const resumed = await harness.run({
      adapter,
      page,
      gateUrl,
      startIndex: 1,
      resumedOnOpenPage: true,
    });

    expect(resumed.outcome.result.ok).toBe(true);
    expect(resumed.started).toEqual(["open-more", "download"]);
    // Not navigated again, and More not clicked again: the menu was already open.
    expect(server.hits("/fixture-artist/captcha")).toBe(pageHits + 1);
    expect(await clicks()).toEqual({ more: 1, download: 1 });
  });

  it("parks again, without acting, when resumed while the captcha is still there", async () => {
    const gateUrl = server.pageUrl("captcha");
    await harness.run({ adapter, page, gateUrl });

    const resumed = await harness.run({
      adapter,
      page,
      gateUrl,
      startIndex: 1,
      resumedOnOpenPage: true,
    });

    expect(resumed.outcome.result).toMatchObject({
      ok: false,
      kind: "needs_human",
      reason: "captcha",
      stepIndex: 1,
    });
    expect(resumed.started).toEqual([]);
    expect(resumed.delays).toEqual([]);
    expect(await clicks()).toEqual({ more: 1, download: 0 });
  });

  it("on a fresh page after a restart, runs from step 0 and skips what is already done", async () => {
    // The human had the track open with the menu showing when the worker came back.
    const gateUrl = server.pageUrl("track");
    await page.goto(gateUrl);
    await page.getByRole("button", { name: "More", exact: true }).click();
    const pageHits = server.hits("/fixture-artist/track");

    const { outcome, started } = await harness.run({ adapter, page, gateUrl, startIndex: 0 });

    expect(outcome.result.ok).toBe(true);
    expect(started).toEqual(["open-track", "open-more", "download"]);
    expect(server.hits("/fixture-artist/track")).toBe(pageHits);
    expect(await clicks()).toEqual({ more: 1, download: 1, purchase: 0 });
  });

  it("reopens the More menu if it was closed during the pause", async () => {
    const gateUrl = server.pageUrl("track");
    await page.goto(gateUrl);

    const { outcome } = await harness.run({ adapter, page, gateUrl, startIndex: 2 });

    expect(outcome.result.ok).toBe(true);
    expect(await clicks()).toEqual({ more: 1, download: 1, purchase: 0 });
  });

  it("asks the human to sign in when the burner account is signed out", async () => {
    const { outcome, started } = await run("signed-out");

    expect(outcome.result).toMatchObject({
      ok: false,
      kind: "needs_human",
      reason: "login_challenge",
      stepIndex: 0,
      stepName: "open-track",
    });
    expect(started).toEqual(["open-track"]);
    expect(await clicks()).toEqual({ more: 0, download: 0 });
  });

  it("carries on from the same step once the human has signed in", async () => {
    const gateUrl = server.pageUrl("signed-out");
    const pageHits = server.hits("/fixture-artist/signed-out");
    await harness.run({ adapter, page, gateUrl });

    await page.evaluate(() => (window as unknown as { __signIn(): void }).__signIn());
    const resumed = await harness.run({
      adapter,
      page,
      gateUrl,
      startIndex: 0,
      resumedOnOpenPage: true,
    });

    expect(resumed.outcome.result.ok).toBe(true);
    expect(server.hits("/fixture-artist/signed-out")).toBe(pageHits + 1);
  });

  it("parks on a sign-in form shown instead of the track", async () => {
    const { outcome } = await run("login-challenge");

    expect(outcome.result).toMatchObject({
      ok: false,
      kind: "needs_human",
      reason: "login_challenge",
      stepName: "open-track",
    });
  });

  it("parks on a page it does not recognise", async () => {
    const { outcome } = await run("unexpected");

    expect(outcome.result).toMatchObject({
      ok: false,
      kind: "needs_human",
      reason: "unexpected_page",
      stepName: "open-track",
    });
  });
});

describe("native adapter: genuinely impossible", () => {
  it("reports a removed track as a dead link", async () => {
    const { outcome, started } = await run("removed");

    expect(outcome.result).toMatchObject({ ok: false, kind: "impossible", reason: "dead_link" });
    expect(started).toEqual(["open-track"]);
  });

  it("reports a track whose download was turned off as file gone", async () => {
    const { outcome } = await run("download-disabled");

    expect(outcome.result).toMatchObject({ ok: false, kind: "impossible", reason: "file_gone" });
    expect(outcome.stepName).toBe("download");
    expect(await clicks()).toEqual({ more: 1 });
  });
});
