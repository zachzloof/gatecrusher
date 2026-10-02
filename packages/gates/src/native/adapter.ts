// SoundCloud's own download button: open the track, open "More", click "Download file".
import type { GateStep, StepResult } from "@gatecrusher/core";
import { errors, type Locator } from "playwright";
import type { BrowserGateAdapter, BrowserGateContext } from "../context.ts";
import { nativeLocators } from "./locators.ts";

export const NATIVE_ADAPTER_ID = "native-soundcloud";

export const SOUNDCLOUD_HOSTS: readonly string[] = [
  "soundcloud.com",
  "www.soundcloud.com",
  "m.soundcloud.com",
];

/** Paths under soundcloud.com that are site pages, not `/<user>/<track>`. */
const NON_USER_SEGMENTS = new Set([
  "discover",
  "feed",
  "you",
  "search",
  "signin",
  "upload",
  "settings",
  "pages",
  "charts",
  "stream",
  "messages",
  "notifications",
  "tags",
  "popular",
]);
/** Second segments that are a user's sub-pages rather than a track. */
const NON_TRACK_SEGMENTS = new Set([
  "sets",
  "tracks",
  "albums",
  "likes",
  "reposts",
  "following",
  "followers",
  "popular-tracks",
  "comments",
]);

const NAVIGATION_TIMEOUT_MS = 45_000;
const GONE_STATUSES = new Set([404, 410]);

const UNEXPECTED_TRACK_PAGE =
  "The SoundCloud track page did not load as expected. Check the tab in the worker's browser window.";
const NOT_SIGNED_IN =
  "The burner account is not signed in to SoundCloud. Sign in with it in the worker's browser window.";
const TRACK_REMOVED =
  "SoundCloud has no track at this link any more: it was removed or made private.";

/** `/<user>/<track>`, optionally followed by a private-share token (`/s-…`). */
function isTrackPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const [user, track, token] = segments;
  if (user === undefined || track === undefined || segments.length > 3) return false;
  if (token !== undefined && !/^s-[A-Za-z0-9]+$/.test(token)) return false;
  return !NON_USER_SEGMENTS.has(user.toLowerCase()) && !NON_TRACK_SEGMENTS.has(track.toLowerCase());
}

function samePage(current: string, target: string): boolean {
  if (!URL.canParse(current)) return false;
  const a = new URL(current);
  const b = new URL(target);
  const trim = (pathname: string) => pathname.replace(/\/$/, "");
  return a.origin === b.origin && trim(a.pathname) === trim(b.pathname);
}

/** Waits for a landmark. False on timeout: the caller decides what its absence means. */
async function appears(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch (error) {
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }
}

const unexpected = (description: string): StepResult => ({
  kind: "needs_human",
  reason: "unexpected_page",
  description,
});

const openTrack: GateStep<BrowserGateContext> = {
  name: "open-track",
  async run(ctx) {
    const { page } = ctx;
    // Already satisfied when re-entered in the same tab after a pause.
    if (!samePage(page.url(), ctx.gateUrl)) {
      const response = await page.goto(ctx.gateUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await ctx.delay("read");
      if (response !== null && GONE_STATUSES.has(response.status())) {
        return { kind: "impossible", reason: "dead_link", detail: TRACK_REMOVED };
      }
    }

    const more = nativeLocators.moreButton(page);
    const signIn = nativeLocators.signInButton(page);
    const notFound = nativeLocators.notFoundMessage(page);
    if (!(await appears(more.or(signIn).or(notFound).first(), ctx.landmarkTimeoutMs))) {
      return unexpected(UNEXPECTED_TRACK_PAGE);
    }

    if (await notFound.isVisible()) {
      return { kind: "impossible", reason: "dead_link", detail: TRACK_REMOVED };
    }
    if (await signIn.isVisible()) {
      return { kind: "needs_human", reason: "login_challenge", description: NOT_SIGNED_IN };
    }
    if (!(await appears(more, ctx.landmarkTimeoutMs))) return unexpected(UNEXPECTED_TRACK_PAGE);
    return { kind: "next" };
  },
};

/** Opens the track's "More" menu unless it is open already. `null` means it is open. */
async function ensureMoreMenuOpen(ctx: BrowserGateContext): Promise<StepResult | null> {
  const { page } = ctx;
  const menu = nativeLocators.moreMenu(page);
  if (await menu.isVisible()) return null;

  const more = nativeLocators.moreButton(page);
  if (!(await appears(more, ctx.landmarkTimeoutMs))) return unexpected(UNEXPECTED_TRACK_PAGE);
  await ctx.delay("action");
  await more.click({ timeout: ctx.landmarkTimeoutMs });
  if (!(await appears(menu, ctx.landmarkTimeoutMs))) {
    return unexpected(
      "The track's More menu did not open. Check the tab in the worker's browser window.",
    );
  }
  return null;
}

const openMore: GateStep<BrowserGateContext> = {
  name: "open-more",
  async run(ctx) {
    return (await ensureMoreMenuOpen(ctx)) ?? { kind: "next" };
  },
};

const download: GateStep<BrowserGateContext> = {
  name: "download",
  async run(ctx) {
    const { page } = ctx;
    // The menu closes when the human clicks elsewhere during a pause; reopen it.
    const menuProblem = await ensureMoreMenuOpen(ctx);
    if (menuProblem !== null) return menuProblem;

    const button = nativeLocators.downloadButton(page);
    if (!(await button.isVisible())) {
      // Only a signed-in session is shown the download entry, so its absence means
      // "no longer offered" only when the session is known to be signed in.
      if (await nativeLocators.signedInNav(page).isVisible()) {
        return {
          kind: "impossible",
          reason: "file_gone",
          detail:
            "SoundCloud no longer offers a download for this track: the uploader turned it off or its download limit was reached.",
        };
      }
      return unexpected(
        "The track's More menu has no Download entry and it is not clear the burner account is signed in. Check the tab in the worker's browser window.",
      );
    }

    await ctx.delay("action");
    const attempt = await ctx.waitForDownload(() =>
      button.click({ timeout: ctx.landmarkTimeoutMs }),
    );
    if (attempt.ok) return { kind: "done", download: attempt.download };

    ctx.log.warn({ kind: attempt.kind, reason: attempt.reason }, "Native download not accepted");
    return unexpected(
      attempt.kind === "no_download"
        ? "Clicking Download did not start a download. Check the tab in the worker's browser window."
        : `SoundCloud delivered a file that is not a usable download: ${attempt.reason.slice(0, 120)}. Check the tab in the worker's browser window.`,
    );
  },
};

export interface NativeAdapterOptions {
  /** The hosts that count as SoundCloud. Tests point this at the fixture server. */
  hosts?: readonly string[];
}

export function createNativeAdapter(options: NativeAdapterOptions = {}): BrowserGateAdapter {
  const hosts = options.hosts ?? SOUNDCLOUD_HOSTS;
  return {
    id: NATIVE_ADAPTER_ID,
    priority: 100,
    allowedHosts: hosts,
    detect: (url) =>
      (url.protocol === "https:" || url.protocol === "http:") &&
      hosts.includes(url.hostname.toLowerCase()) &&
      isTrackPath(url.pathname),
    steps: [openTrack, openMore, download],
  };
}
