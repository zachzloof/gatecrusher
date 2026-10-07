// Stands in for Playwright in the desktop build. The desktop app never drives a browser
// (the browser path is paused, see docs/PIVOT.md), so it ships without one; this keeps
// the worker's imports satisfied and fails loudly if anything tries.
class TimeoutError extends Error {
  override name = "TimeoutError";
}

export const errors = { TimeoutError };

export const chromium = {
  launchPersistentContext(): Promise<never> {
    return Promise.reject(new Error("The desktop app does not include a browser."));
  },
};
