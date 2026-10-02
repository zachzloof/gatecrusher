import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { ScreenshotOptions } from "@gatecrusher/core";
import type { Page } from "playwright";

export const SCREENSHOTS_DIRECTORY = "screenshots";

export interface ScreenshotterOptions {
  /** Absolute path of the data dir. */
  dataDir: string;
  runId: string;
  jobId: string;
}

/** Takes a screenshot of a page and returns its path relative to the data dir. */
export type Screenshotter = (
  page: Page,
  label: string,
  options?: ScreenshotOptions,
) => Promise<string>;

const SCREENSHOT_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeLabel(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "page"
  );
}

/**
 * Screenshots for one job, saved as `screenshots/<run-id>/<job-id>/<seq>-<label>.png`.
 * The sequence continues from what is already on disk, so a resumed job keeps counting.
 */
export function createScreenshotter(options: ScreenshotterOptions): Screenshotter {
  if (!UUID.test(options.runId) || !UUID.test(options.jobId)) {
    throw new Error("Screenshots are stored under run and job ids, which must be UUIDs");
  }
  const directory = path.resolve(
    options.dataDir,
    SCREENSHOTS_DIRECTORY,
    options.runId,
    options.jobId,
  );
  let sequence: number | undefined;

  return async (page, label, screenshotOptions = {}) => {
    if (sequence === undefined) {
      await mkdir(directory, { recursive: true });
      sequence = (await readdir(directory)).filter((name) => name.endsWith(".png")).length;
    }
    sequence += 1;
    const fileName = `${String(sequence).padStart(4, "0")}-${safeLabel(label)}.png`;
    await page.screenshot({
      path: path.join(directory, fileName),
      timeout: SCREENSHOT_TIMEOUT_MS,
      // Password fields are always covered; on a sign-in page every input is.
      mask: [
        page.locator(screenshotOptions.maskInputs === true ? "input" : 'input[type="password"]'),
      ],
    });
    return [SCREENSHOTS_DIRECTORY, options.runId, options.jobId, fileName].join("/");
  };
}
