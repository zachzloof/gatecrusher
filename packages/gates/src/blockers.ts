// The shared blocker detector. It only ever reads the page: it never clicks, types or
// otherwise touches a challenge. Whatever it finds is handed to the human.

// DOM types for `collectSnapshot`, which runs inside the page. A directive rather than a
// tsconfig `lib`, so it also holds in the apps that consume this package as source.
/// <reference lib="dom" />
import type { Blocker } from "@gatecrusher/core";
import type { Page } from "playwright";

/** What the detector reads from a page. Collected in one round-trip, classified in Node. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** `src` of every iframe that takes up space on the page. */
  visibleFrameSources: string[];
  /**
   * The body text, but only of a short page. Interstitials are short; a real track or
   * gate page is long and full of untrusted text (a track can be titled "Are you a
   * robot"), so its text is never matched.
   */
  shortBodyText: string;
  hasVisiblePasswordField: boolean;
}

export interface BlockerOptions {
  /** Hosts the job may be on (subdomains included). Undefined: anywhere. */
  allowedHosts?: readonly string[] | undefined;
}

const SHORT_PAGE_CHARACTERS = 2_000;

const CAPTCHA_FRAME =
  /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|turnstile|captcha-delivery\.com|datadome|perimeterx|px-captcha|arkoselabs|funcaptcha|geetest/i;
/** reCAPTCHA v3's corner badge is not a challenge. */
const PASSIVE_CAPTCHA_FRAME = /size=invisible/i;
const CAPTCHA_TITLE = /^(just a moment|attention required)/i;
const CAPTCHA_TEXT =
  /verify (that )?you(.re| are) (a )?human|are you a robot|i(.m| am) not a robot|checking your browser|unusual traffic|complete the (security check|captcha)|press (and|&) hold/i;

const EMAIL_CONFIRMATION_TEXT =
  /check your (inbox|e-?mail)|(confirm|verify) your e-?mail|we(.ve| have)? (just )?(sent|e-?mailed) (you )?(a|an|the) (code|e-?mail|link)|enter the code we (sent|e-?mailed)/i;

const LOGIN_CHALLENGE_TEXT =
  /confirm it.s you|two-factor|2-step verification|two-step verification|enter (the|your) (verification|security|6-digit) code|sign in to continue|log in to continue/i;
const LOGIN_PATH = /^\/(signin|sign-in|login|log-in)(\/|$)/i;

function isAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const suffix = allowed.toLowerCase();
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

/** Pure: decides what, if anything, on a page needs the human. */
export function classifyBlocker(
  snapshot: PageSnapshot,
  options: BlockerOptions = {},
): Blocker | null {
  const text = snapshot.shortBodyText;

  const captchaFrame = snapshot.visibleFrameSources.some(
    (source) => CAPTCHA_FRAME.test(source) && !PASSIVE_CAPTCHA_FRAME.test(source),
  );
  if (captchaFrame || CAPTCHA_TITLE.test(snapshot.title) || CAPTCHA_TEXT.test(text)) {
    return {
      reason: "captcha",
      description: "Solve the captcha in the worker's browser window.",
    };
  }

  if (EMAIL_CONFIRMATION_TEXT.test(text)) {
    return {
      reason: "email_confirmation",
      description: "Confirm the email the page is asking about, in the worker's browser window.",
    };
  }

  const url = URL.canParse(snapshot.url) ? new URL(snapshot.url) : null;
  const isWebPage = url !== null && (url.protocol === "https:" || url.protocol === "http:");

  if (
    snapshot.hasVisiblePasswordField ||
    LOGIN_CHALLENGE_TEXT.test(text) ||
    (isWebPage && LOGIN_PATH.test(url.pathname))
  ) {
    return {
      reason: "login_challenge",
      description: "Finish signing in with the burner account in the worker's browser window.",
    };
  }

  if (
    isWebPage &&
    options.allowedHosts !== undefined &&
    !isAllowedHost(url.hostname, options.allowedHosts)
  ) {
    return {
      reason: "unexpected_page",
      // A hostname can be 253 characters; the instruction must stay a short sentence.
      description: `The tab ended up on ${url.hostname.slice(0, 80)}, which is not where this download happens. Check it in the worker's browser window.`,
    };
  }

  return null;
}

/** Runs inside the page. Reads the DOM and nothing else. */
function collectSnapshot(shortPageCharacters: number): PageSnapshot {
  const takesUpSpace = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    return box.width > 1 && box.height > 1 && element.checkVisibility({ visibilityProperty: true });
  };

  const bodyText = document.body?.innerText ?? "";
  return {
    url: location.href,
    title: document.title,
    visibleFrameSources: Array.from(document.querySelectorAll("iframe"))
      .filter(takesUpSpace)
      .map((frame) => frame.src),
    shortBodyText: bodyText.length <= shortPageCharacters ? bodyText : "",
    hasVisiblePasswordField: Array.from(document.querySelectorAll('input[type="password"]')).some(
      takesUpSpace,
    ),
  };
}

const NAVIGATION_SETTLE_TIMEOUT_MS = 10_000;

async function snapshotPage(page: Page): Promise<PageSnapshot> {
  try {
    return await page.evaluate(collectSnapshot, SHORT_PAGE_CHARACTERS);
  } catch (error) {
    if (!(error instanceof Error) || !/context was destroyed|navigation/i.test(error.message)) {
      throw error;
    }
    // The page navigated under the read. Look again once the new document is there.
    await page.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_SETTLE_TIMEOUT_MS });
    return page.evaluate(collectSnapshot, SHORT_PAGE_CHARACTERS);
  }
}

/** Looks at the page for anything only the human can deal with. */
export async function detectBlockers(
  page: Page,
  options: BlockerOptions = {},
): Promise<Blocker | null> {
  return classifyBlocker(await snapshotPage(page), options);
}
