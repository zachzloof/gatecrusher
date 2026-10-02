import type {
  AdapterState,
  DownloadAttempt,
  GateAdapter,
  GateContext,
  GateLog,
  GateTrack,
} from "@gatecrusher/core";
import { errors, type Page } from "playwright";
import { detectBlockers } from "./blockers.ts";
import type { DelayProvider } from "./delay.ts";
import type { DownloadCapture } from "./downloads/store.ts";
import type { Screenshotter } from "./screenshots.ts";

/** The context every browser adapter's steps receive. */
export type BrowserGateContext = GateContext<Page>;
export type BrowserGateAdapter = GateAdapter<BrowserGateContext>;

export const DEFAULT_LANDMARK_TIMEOUT_MS = 20_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface GateContextOptions {
  page: Page;
  track: GateTrack;
  gateUrl: string;
  /** Hosts the adapter expects to stay on. The gate URL's own host is always allowed. */
  allowedHosts: readonly string[] | undefined;
  /** Required: there is no context, and so no adapter run, without pacing. */
  delay: DelayProvider;
  screenshots: Screenshotter;
  downloads: DownloadCapture;
  state: AdapterState;
  log: GateLog;
  emit(note: { message: string }): Promise<void>;
  landmarkTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

export function createGateContext(options: GateContextOptions): BrowserGateContext {
  const { page } = options;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const allowedHosts =
    options.allowedHosts === undefined
      ? undefined
      : [...options.allowedHosts, new URL(options.gateUrl).hostname];

  async function waitForDownload(trigger: () => Promise<void>): Promise<DownloadAttempt> {
    const pending = page.waitForEvent("download", { timeout: downloadTimeoutMs });
    // If the trigger throws, nothing awaits `pending`; its rejection must not go unhandled.
    pending.catch(() => undefined);
    await trigger();
    try {
      return await options.downloads(await pending);
    } catch (error) {
      if (error instanceof errors.TimeoutError) {
        return {
          ok: false,
          kind: "no_download",
          reason: `no download started within ${Math.round(downloadTimeoutMs / 1000)} seconds`,
        };
      }
      throw error;
    }
  }

  return {
    page,
    track: options.track,
    gateUrl: options.gateUrl,
    landmarkTimeoutMs: options.landmarkTimeoutMs ?? DEFAULT_LANDMARK_TIMEOUT_MS,
    delay: (kind) => options.delay.wait(kind),
    screenshot: (label, screenshotOptions) => options.screenshots(page, label, screenshotOptions),
    emit: (note) => options.emit(note),
    checkBlockers: () => detectBlockers(page, { allowedHosts }),
    waitForDownload,
    state: options.state,
    log: options.log,
  };
}
