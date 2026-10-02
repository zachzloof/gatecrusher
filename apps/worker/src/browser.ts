import { chromium, type BrowserContext, type Page } from "playwright";
import type { Logger } from "pino";

/** Opens the persistent profile. Injected so tests can use a throwaway headless one. */
export type BrowserLauncher = (profileDir: string) => Promise<BrowserContext>;

/**
 * The only launcher the worker and the login script use: a real, visible Chromium on
 * the persistent burner profile. Hard rules: no headless mode, and no stealth or
 * fingerprint-evasion flags — this is an ordinary browser a human can see and use.
 */
export const launchHeadedBrowser: BrowserLauncher = (profileDir) =>
  chromium.launchPersistentContext(profileDir, {
    headless: false,
    acceptDownloads: true,
    // Use the window's own size, like a browser a person opened.
    viewport: null,
  });

export interface BrowserSession {
  /** A new tab in the profile's window, launching the browser on first use. */
  newPage(): Promise<Page>;
  /** Closes the browser cleanly so the profile is not corrupted. */
  close(): Promise<void>;
}

export interface BrowserSessionOptions {
  profileDir: string;
  launch: BrowserLauncher;
  log: Logger;
}

/**
 * One browser for the whole worker, opened when the first browser job needs it. If the
 * human closes the window, the next job simply opens it again.
 */
export function createBrowserSession(options: BrowserSessionOptions): BrowserSession {
  let opening: Promise<BrowserContext> | undefined;

  function open(): Promise<BrowserContext> {
    opening ??= options.launch(options.profileDir).then(
      (context) => {
        context.on("close", () => {
          opening = undefined;
          options.log.info("Browser window closed");
        });
        options.log.info("Browser opened on the persistent profile");
        return context;
      },
      (error: unknown) => {
        opening = undefined;
        throw error;
      },
    );
    return opening;
  }

  return {
    newPage: async () => (await open()).newPage(),
    close: async () => {
      if (opening === undefined) return;
      const context = await opening;
      await context.close();
    },
  };
}
