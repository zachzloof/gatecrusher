import { expect, test, type Page } from "@playwright/test";
import type {
  PlaylistDetailResponse,
  RunResponse,
  TrackDto,
  TrackJobDto,
} from "../lib/api-schemas";
import { DETAIL, fakeApi, PLAYLIST_ID, TRACKS } from "./fixtures";

// The run is faked at the network boundary, like the ingest: the "worker" here is the
// sequence of answers the playlist route gives. No database, queue or browser job.
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const SCREENSHOT_URL = `/api/screenshots/${RUN_ID}/${JOB_ID}/0002-open-more.png`;
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const NOTHING: RunResponse = {
  runId: null,
  queued: 0,
  resumed: 0,
  alreadyDownloaded: 0,
  alreadyActive: 0,
};

function job(overrides: Partial<TrackJobDto>): TrackJobDto {
  return {
    status: "QUEUED",
    stepName: null,
    needsHuman: null,
    manual: null,
    error: null,
    ...overrides,
  };
}

/** The fixture playlist with its native track (the first one) in the given state. */
function detailWith(native: Partial<TrackDto>, extra: TrackDto[] = []): PlaylistDetailResponse {
  const [first, ...rest] = TRACKS;
  if (first === undefined) throw new Error("fixture playlist is empty");
  return { ...DETAIL, tracks: [{ ...first, ...native }, ...rest, ...extra] };
}

const PAUSED = detailWith({
  job: job({
    status: "WAITING_FOR_HUMAN",
    stepName: "open-more",
    needsHuman: {
      reason: "captcha",
      description: "Solve the captcha in the worker's browser window.",
      screenshotUrl: SCREENSHOT_URL,
    },
  }),
});

const DOWNLOADED = detailWith({
  job: job({ status: "SUCCEEDED" }),
  download: {
    fileName: "Fixture Artist - Native Download.mp3",
    sizeBytes: 9_400_000,
    kind: "audio",
  },
});

/** Answers the playlist route with a state the test can move on, as the worker would. */
async function fakePlaylist(
  page: Page,
  initial: PlaylistDetailResponse,
): Promise<{ becomes: (next: PlaylistDetailResponse) => void }> {
  let current = initial;
  await page.route(`**/api/playlists/${PLAYLIST_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(current),
    }),
  );
  return {
    becomes: (next) => {
      current = next;
    },
  };
}

/** Fakes "Download tracks" and counts the clicks that reached the server. */
async function fakeRun(
  page: Page,
  status: number,
  body: unknown,
): Promise<{ count: () => number }> {
  let posts = 0;
  await page.route(`**/api/playlists/${PLAYLIST_ID}/runs`, (route) => {
    posts += 1;
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { count: () => posts };
}

const trackRows = (page: Page) => page.getByRole("table", { name: "Tracks" }).locator("tbody tr");
const runBar = (page: Page) => page.getByRole("region", { name: "Downloads" });
const runButton = (page: Page) => page.getByRole("button", { name: "Download tracks" });

test.beforeEach(async ({ page }) => {
  await fakeApi(page);
});

test("run tracks: queued, running with its step, then downloaded", async ({ page }) => {
  const playlist = await fakePlaylist(page, DETAIL);
  const run = await fakeRun(page, 202, { ...NOTHING, runId: RUN_ID, queued: 1 });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  const native = trackRows(page).first();
  await expect(native).toContainText("Native Download (Original Mix)");
  await expect(runBar(page)).toContainText("Downloaded 0 of 6 tracks");
  const bar = page.getByRole("progressbar", { name: "Playlist progress" });
  await expect(bar).toHaveAttribute("aria-valuemax", "6");
  await expect(bar).toHaveAttribute("aria-valuenow", "0");
  // Never run: no job status yet.
  await expect(native).not.toContainText("Queued");

  playlist.becomes(detailWith({ job: job({ status: "QUEUED" }) }));
  await runButton(page).click();
  await expect(runBar(page)).toContainText("Queued 1 track.");
  expect(run.count()).toBe(1);
  await expect(native).toContainText("Queued");
  await expect(runBar(page)).toContainText("1 in progress");

  // The page keeps asking while work is in progress, so it follows the worker.
  playlist.becomes(detailWith({ job: job({ status: "RUNNING", stepName: "open-more" }) }));
  await expect(native).toContainText("Running");
  await expect(native).toContainText("open-more");

  playlist.becomes(DOWNLOADED);
  await expect(native).toContainText("Downloaded");
  await expect(runBar(page)).toContainText("Downloaded 1 of 6 tracks");
  await expect(bar).toHaveAttribute("aria-valuenow", "1");

  // The other tracks are still to download, so the run can be started again.
  await expect(runButton(page)).toBeEnabled();
  // Tracks without a job show no job status.
  await expect(trackRows(page).nth(1)).not.toContainText("Queued");
});

test("a paused track shows what it needs and its screenshot, and running again retries it", async ({
  page,
}) => {
  const playlist = await fakePlaylist(page, PAUSED);
  await page.route("**/api/screenshots/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG }),
  );
  const run = await fakeRun(page, 202, { ...NOTHING, resumed: 1 });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  const paused = page.getByRole("region", { name: "Paused" });
  await expect(paused).toContainText("Needs you");
  await expect(paused).toContainText("Fixture Artist — Native Download (Original Mix)");
  await expect(paused).toContainText("Solve the captcha in the worker's browser window.");
  await expect(paused).toContainText("step open-more");
  await expect(paused).toContainText("click Download tracks again");

  const screenshot = paused.getByRole("img", { name: /showing a captcha/ });
  await expect(screenshot).toBeVisible();
  await expect(paused.getByRole("link").first()).toHaveAttribute("href", SCREENSHOT_URL);
  expect(await screenshot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await expect(trackRows(page).first()).toContainText("Needs you");
  await expect(runBar(page)).toContainText("1 needs you");

  // The human dealt with it in the worker's browser; clicking again retries.
  await expect(runButton(page)).toBeEnabled();
  playlist.becomes(DOWNLOADED);
  await runButton(page).click();
  await expect(runBar(page)).toContainText("Retrying 1 track that needed you.");
  expect(run.count()).toBe(1);

  await expect(trackRows(page).first()).toContainText("Downloaded");
  await expect(paused).toHaveCount(0);
});

test("a run that cannot start explains why and can be tried again", async ({ page }) => {
  await fakePlaylist(page, DETAIL);
  const run = await fakeRun(page, 500, {
    error: {
      code: "internal",
      message: "Could not reach the database, so nothing was started. Try again in a moment.",
    },
  });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await runButton(page).click();

  await expect(runBar(page).getByRole("alert")).toContainText("Could not reach the database");
  await expect(runButton(page)).toBeEnabled();
  expect(run.count()).toBe(1);
});

test("manual and failed tracks say why", async ({ page }) => {
  const first = TRACKS[0];
  if (first === undefined) throw new Error("fixture playlist is empty");
  const failed: TrackDto = {
    ...first,
    id: "22222222-2222-4222-8222-000000000099",
    position: 6,
    title: "Second Native",
    job: job({ status: "FAILED", error: "Target page, context or browser has been closed" }),
  };
  await fakePlaylist(
    page,
    detailWith(
      {
        job: job({
          status: "MANUAL",
          manual: { reason: "dead_link", detail: "SoundCloud has no track at this link any more." },
        }),
      },
      [failed],
    ),
  );
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await expect(trackRows(page).first()).toContainText("Manual");
  await expect(trackRows(page).first()).toContainText("dead link");
  await expect(trackRows(page).last()).toContainText("Failed");
  await expect(runBar(page)).toContainText("Downloaded 0 of 7 tracks · 1 manual · 1 failed");
  // Both can be run again.
  await expect(runButton(page)).toBeEnabled();
});

test("a playlist whose tracks are all downloaded cannot be run", async ({ page }) => {
  await fakePlaylist(page, { ...DOWNLOADED, tracks: DOWNLOADED.tracks.slice(0, 1) });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  await expect(runBar(page)).toContainText("Downloaded 1 of 1 track");
  await expect(runButton(page)).toBeDisabled();
});

test("the page with statuses and a paused track fits the viewport", async ({ page }) => {
  await fakePlaylist(page, PAUSED);
  await page.route("**/api/screenshots/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG }),
  );
  await page.goto(`/playlists/${PLAYLIST_ID}`);
  await expect(page.getByRole("region", { name: "Paused" })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("cancel stops the queued tracks, which say so and can be queued again", async ({ page }) => {
  const playlist = await fakePlaylist(page, detailWith({ job: job({ status: "QUEUED" }) }));
  const cancels: string[] = [];
  await page.route(`**/api/playlists/${PLAYLIST_ID}/runs`, (route) => {
    cancels.push(route.request().method());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cancelled: 1, running: 0 }),
    });
  });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  const cancel = page.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeEnabled();
  playlist.becomes(detailWith({ job: job({ status: "CANCELLED" }) }));
  await cancel.click();

  await expect(runBar(page)).toContainText("Cancelled 1 track.");
  expect(cancels).toEqual(["DELETE"]);
  await expect(trackRows(page).first()).toContainText("Cancelled");
  await expect(trackRows(page).first()).toContainText("Cancelled before it started");
  await expect(runBar(page)).toContainText("1 cancelled");
  // Nothing is queued any more, and the tracks can be downloaded again.
  await expect(cancel).toBeDisabled();
  await expect(runButton(page)).toBeEnabled();
});

test("failed tracks show why on the page, and the run bar groups the reasons", async ({ page }) => {
  const ffmpeg =
    "yt-dlp needs ffmpeg to embed the tags and artwork. Install it (winget install Gyan.FFmpeg), restart the worker, then click Download tracks.";
  const [, second, third] = TRACKS;
  if (second === undefined || third === undefined) throw new Error("fixture playlist is short");
  await fakePlaylist(page, {
    ...DETAIL,
    tracks: [
      { ...(TRACKS[0] ?? second), job: job({ status: "FAILED", error: ffmpeg }) },
      { ...second, job: job({ status: "FAILED", error: ffmpeg }) },
      { ...third, job: job({ status: "FAILED", error: "yt-dlp timed out downloading the file." }) },
      ...TRACKS.slice(3),
    ],
  });
  await page.goto(`/playlists/${PLAYLIST_ID}`);

  // The reason is printed on the row itself, not only in a tooltip.
  await expect(trackRows(page).first()).toContainText("yt-dlp needs ffmpeg");
  const reasons = runBar(page).getByRole("list", { name: "Why tracks failed" });
  await expect(reasons.getByRole("listitem").first()).toContainText("2×");
  await expect(reasons.getByRole("listitem").first()).toContainText("yt-dlp needs ffmpeg");
  await expect(reasons.getByRole("listitem").nth(1)).toContainText("1×");
  await expect(reasons.getByRole("listitem").nth(1)).toContainText("timed out");
});
