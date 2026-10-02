// Every selector the native SoundCloud adapter relies on, in one place, so a site
// redesign is a one-file fix. Modelled on soundcloud.com track pages as of 2026-10.
// The fixtures in ./__fixtures__ reproduce exactly this structure.
import type { Locator, Page } from "playwright";

export const nativeLocators = {
  /** The account menu in the header: only there when signed in. */
  signedInNav: (page: Page): Locator => page.locator(".header__userNav").first(),

  /** The header's "Sign in" button: only there when signed out. */
  signInButton: (page: Page): Locator =>
    page
      .locator(".header__loginMenu")
      .getByRole("button", { name: /^sign in$/i })
      .first(),

  /** "More" in the action row under the track's waveform (not the ones on comments). */
  moreButton: (page: Page): Locator =>
    page.locator(".listenEngagement").getByRole("button", { name: "More", exact: true }).first(),

  /** The menu "More" opens. */
  moreMenu: (page: Page): Locator => page.locator(".moreActions").first(),

  /**
   * SoundCloud's own download entry in that menu. A button, never a link: the track's
   * buy / "free download" link is an anchor elsewhere on the page and is not touched.
   */
  downloadButton: (page: Page): Locator =>
    page
      .locator(".moreActions")
      .getByRole("button", { name: /^download( file)?$/i })
      .first(),

  /** SoundCloud's "We can't find that track." page. */
  notFoundMessage: (page: Page): Locator => page.getByText(/we can.t find that track/i).first(),
} as const;

/** Whether the page shows the signed-in header. Reads the DOM only. */
export function isSignedInToSoundcloud(page: Page): Promise<boolean> {
  return nativeLocators.signedInNav(page).isVisible();
}
