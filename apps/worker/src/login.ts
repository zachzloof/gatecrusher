// The one-time interactive login. The human types the burner account's credentials
// into the real SoundCloud page; this code only ever asks "is the signed-in header
// showing?". It reads no input, no cookie and no storage, and logs none of them. The
// session lives in the browser profile and nowhere else.
import { isSignedInToSoundcloud } from "@gatecrusher/gates";
import type { BrowserContext, Page } from "playwright";

export const SOUNDCLOUD_SIGN_IN_URL = "https://soundcloud.com/signin";
export const SOUNDCLOUD_HOME_URL = "https://soundcloud.com/discover";

const DEFAULT_POLL_MS = 1_500;
/** Long enough for a password manager, a second factor and a captcha. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const CONFIRM_TIMEOUT_MS = 30_000;

export type LoginResult =
  | { ok: true }
  | {
      ok: false;
      kind: "window_closed" | "timed_out" | "not_confirmed";
      reason: string;
    };

export interface LoginOptions {
  context: BrowserContext;
  signInUrl?: string;
  /** A page that shows the signed-in header only with a working session. */
  homeUrl?: string;
  isSignedIn?: (page: Page) => Promise<boolean>;
  pollMs?: number;
  /** How long to wait for the human to sign in. */
  timeoutMs?: number;
  /** How long the signed-in header may take to show after the confirming reload. */
  confirmTimeoutMs?: number;
  /** Called once the sign-in page is open and the wait for the human begins. */
  onWaiting?: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The first open tab showing the signed-in header, if any. */
async function findSignedInPage(
  context: BrowserContext,
  isSignedIn: (page: Page) => Promise<boolean>,
): Promise<Page | undefined> {
  for (const page of context.pages()) {
    try {
      if (await isSignedIn(page)) return page;
    } catch {
      // The tab is navigating or was just closed; it is looked at again on the next poll.
    }
  }
  return undefined;
}

/**
 * Opens the sign-in page, waits for the human to log in by hand, then confirms the
 * session holds on a fresh page load.
 */
export async function runLogin(options: LoginOptions): Promise<LoginResult> {
  const { context } = options;
  const isSignedIn = options.isSignedIn ?? isSignedInToSoundcloud;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let closed = false;
  context.on("close", () => {
    closed = true;
  });

  const first = context.pages()[0] ?? (await context.newPage());
  await first.goto(options.signInUrl ?? SOUNDCLOUD_SIGN_IN_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  options.onWaiting?.();

  let signedInPage: Page | undefined;
  while (signedInPage === undefined) {
    if (closed) {
      return {
        ok: false,
        kind: "window_closed",
        reason: "The browser window was closed before the login finished.",
      };
    }
    signedInPage = await findSignedInPage(context, isSignedIn);
    if (signedInPage !== undefined) break;
    if (Date.now() >= deadline) {
      return {
        ok: false,
        kind: "timed_out",
        reason:
          "Gave up waiting for the login. If you did sign in, SoundCloud's signed-in page was not recognised.",
      };
    }
    await sleep(pollMs);
  }

  // Confirm: the session must survive a fresh page load, not just show once.
  await signedInPage.goto(options.homeUrl ?? SOUNDCLOUD_HOME_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const confirmBy = Date.now() + (options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS);
  while (Date.now() < confirmBy && !closed) {
    if ((await findSignedInPage(context, isSignedIn)) !== undefined) return { ok: true };
    await sleep(pollMs);
  }
  return {
    ok: false,
    kind: "not_confirmed",
    reason: "The login showed, but the session did not hold after reloading SoundCloud.",
  };
}
