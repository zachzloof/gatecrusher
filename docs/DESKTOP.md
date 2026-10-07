# Desktop app

Gatecrusher as an installer for a few friends to test: one download, nothing else to
install. Added 2026-10-07. The code is in `apps/desktop`.

## What is inside

| Piece | Where it comes from |
| --- | --- |
| Electron 44 (window, Node.js 24 for the child processes) | npm |
| The web app (UI + API) | `apps/web`, built as a Next.js standalone server |
| The worker | `apps/worker`, bundled into one file **without Playwright**: the desktop app never drives a browser |
| Postgres 17 | `embedded-postgres` binaries, run with `pg_ctl` |
| yt-dlp | the latest release, copied to the user's folder on first start and updated with `yt-dlp -U` on every start |
| ffmpeg, ffprobe | yt-dlp's Windows build; Martin Riedl's macOS builds |

On start the app checks the build may run (below), starts Postgres on a free port on
127.0.0.1 (password-protected, no other network access), applies migrations, then runs
web and the worker as child processes and shows the web app in its window. On quit it
stops all of them; a download in progress is killed and runs again on the next start.

Where a friend's data lives (kept when uninstalling):

| | Windows | macOS |
| --- | --- | --- |
| Everything | `%LOCALAPPDATA%\Gatecrusher` | `~/Library/Application Support/Gatecrusher` |
| Downloads | `…\data\downloads\<playlist>` | same |
| Logs | `…\logs` (`main`, `web`, `worker`, `postgres`, `yt-dlp-update`) | same |

**File → Open Downloads Folder** and the playlist page's **Open folder** button open the
downloads. **File → Open Log Files** opens the logs, which hold no passwords or tokens.

## Access code and end date

Set in [apps/desktop/src/main/build-config.ts](../apps/desktop/src/main/build-config.ts):

- `ACCESS_CODE_SHA256`: the SHA-256 of the code, lower-cased and trimmed. Current code:
  **gatecrusher**. Asked once per machine per build; a build with a new code asks again.
- `BUILD_EXPIRES_AT`: **2026-12-07 23:59:59 UTC**. After that the app shows "This test
  build has ended" and asks for the new installer. A copy left open stops too (checked
  every 15 minutes). Winding the clock back does not help: the app remembers the latest
  time it has seen.

This is a soft lock. It runs on the friend's machine, so someone determined can get round
it; it stops casual use after the test period. A real paywall needs a server that issues
and checks licences.

To hand out a new build, change the code and/or date:

```sh
node -e "console.log(require('crypto').createHash('sha256').update('new code'.trim().toLowerCase()).digest('hex'))"
```

Paste the hash and the new date into `build-config.ts`, update the test in
`access.test.ts` (it pins both), bump `version` in `apps/desktop/package.json`, and build.

## Building

### Windows (on a Windows PC)

```sh
pnpm install
pnpm --filter @gatecrusher/desktop fetch-binaries   # once, and to pick up new yt-dlp/ffmpeg
pnpm --filter @gatecrusher/desktop dist
```

The installer is `apps/desktop/release/Gatecrusher-<version>-win-x64.exe` (about 215 MB).
`fetch-binaries` checks every download against its publisher's checksum and copies the
Visual C++ runtime Postgres needs from this PC.

If electron-builder stops with `EPERM: operation not permitted, rename … electron-builder\Cache`,
run `dist` again: antivirus briefly locked a file it had just unpacked.

Check the build before sending it:

```sh
pnpm --filter @gatecrusher/desktop smoke     # starts the real app from stage/, throwaway data
```

The smoke test points the app at a throwaway folder with `GATECRUSHER_ROOT`. Only a copy
run from the repo reads it; an installed app ignores it. The app needs no `.env`: it gives
web and the worker their settings itself.

### macOS (on GitHub, or on a Mac)

There is no Mac here, so the Mac installers are built by GitHub Actions: **Actions →
Desktop installers → Run workflow**. It builds Windows, Apple Silicon and Intel, and
attaches `Gatecrusher-…-mac-arm64.dmg` / `-mac-x64.dmg` / the Windows `.exe` to the run.
On a Mac the commands are the same as on Windows; build on the kind of Mac (Apple
Silicon or Intel) you are building for.

**The Mac build is untested.** Before giving it to anyone, open it on a Mac once.

## Unsigned: what friends will see

There is no code-signing certificate (Windows) or Apple Developer ID (macOS), so:

- **Windows:** "Windows protected your PC" → **More info** → **Run anyway**. Once.
- **macOS:** "Gatecrusher can't be opened because Apple cannot check it for malicious
  software." → **System Settings → Privacy & Security** → **Open Anyway** (or right-click
  the app → **Open**). Once. If macOS says the app "is damaged", run
  `xattr -cr /Applications/Gatecrusher.app` in Terminal.

## What to send friends

Paste this with the installer:

> 1. Install Gatecrusher. Windows will warn that it is from an unknown publisher: click
>    **More info → Run anyway**. (Mac: open it from **System Settings → Privacy &
>    Security → Open Anyway**.)
> 2. Enter the access code: **gatecrusher**.
> 3. Connect SoundCloud: the app walks you through copying a login token from your
>    browser. Use a spare SoundCloud account, not your main one.
> 4. Paste a playlist link, click **Download tracks**. **Open folder** shows the files.
>
> The test build stops working on 7 December. If something breaks, send me the files from
> **File → Open Log Files**.

Things worth telling them plainly: downloads run as their SoundCloud account and pull
tracks whether or not the uploader enabled downloads, which SoundCloud's terms forbid, so
the account could be limited or banned; and the app does one track at a time on purpose.

## Updating

There is no auto-update. Send the new installer; installing it over the old one keeps the
data and downloads. yt-dlp updates itself on every start, so SoundCloud changes are
usually handled without a new build.
