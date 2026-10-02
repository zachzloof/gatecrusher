// One-time interactive login for the burner SoundCloud account:
//   pnpm --filter @gatecrusher/worker login
//
// Opens the worker's own browser profile, headed, on SoundCloud's sign-in page and waits
// for you to log in by hand. Stop the worker first: a profile can only be open in one
// browser at a time.
import type { BrowserContext } from "playwright";
import { launchHeadedBrowser } from "../browser.ts";
import { loadEnv } from "../env.ts";
import { createLogger } from "../logger.ts";
import { runLogin } from "../login.ts";
import { browserProfileDir, resolveDataDir } from "../paths.ts";

// Also refuses to go on if the environment asks for a headless browser.
const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const profileDir = browserProfileDir(resolveDataDir(env.DATA_DIR));

let context: BrowserContext | undefined;
try {
  context = await launchHeadedBrowser(profileDir);
} catch (error) {
  log.fatal(
    { err: error, profileDir },
    "Could not open the browser profile. If the worker is running, stop it first. If Chromium is missing, run: pnpm --filter @gatecrusher/worker exec playwright install chromium",
  );
  process.exit(1);
}

try {
  const result = await runLogin({
    context,
    onWaiting: () =>
      log.info(
        "Sign in to the burner SoundCloud account in the browser window. Nothing you type is read or stored by Gatecrusher. Waiting...",
      ),
  });
  if (result.ok) {
    log.info({ profileDir }, "Logged in. The session is saved in the browser profile.");
  } else {
    log.error({ kind: result.kind }, result.reason);
    process.exitCode = 1;
  }
} catch (error) {
  log.error({ err: error }, "The login did not complete");
  process.exitCode = 1;
} finally {
  // Closed cleanly so the session is flushed to the profile.
  await context.close();
}
