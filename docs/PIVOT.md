# Project notes

Where Gatecrusher stands, what is paused and why, and the plan from here. Updated
2026-10-06. The slice plan the first three slices were built against is in
[SLICES.md](SLICES.md); it is kept as a record, not as the current plan.

## What has been done

**Slice 1 — scaffold.** pnpm + Turborepo monorepo (`apps/web`, `apps/worker`,
`packages/core`, `packages/db`, `packages/gates`), Postgres + Redis via Docker Compose,
Drizzle schema and migrations, env validation, dark UI shell with nav, `/api/health`
with a worker-offline banner, GitHub Actions CI.

**Slice 2 — ingest + classify.** Paste a playlist URL; tracks are read through
SoundCloud's api-v2 (with a `yt-dlp -J` fallback for metadata), stored idempotently, and
classified `native` / `gate` / `buy` / `none` by a table-tested classifier. Tracks table
with sort and filter; buy list with CSV export (the list pages were removed on
2026-10-07; the links now sit in the tracks table). No browser involved.

**Slice 3 — browser runtime.** A headed Playwright browser on a persistent profile, a
login script, the `GateAdapter` contract and step runner, a shared blocker detector,
download verification (bytes sniffed as audio or as a zip containing audio, above
`MIN_DOWNLOAD_BYTES`), the downloads layout, a native SoundCloud adapter, "Run native
tracks" on the playlist page with live status and a paused list. 674 unit/integration
tests and 69 UI e2e tests pass. Everything was tested offline against fixture pages.

**Not committed.** Nothing since the "Changes to the plan" commit is in git; slices 1–3
are all untracked. `.claude/settings.json` denies `git commit` and `git push` to the
assistant, so commits are the owner's to make.

## What happened

The first real use of the slice 3 browser, on 2026-10-02, was refused by SoundCloud's
anti-bot system at the sign-in page ("We detected unusual activity from your device or
network"). An ordinary browser on the same network got a warning but was let in. The
working conclusion: SoundCloud will not accept an automation-controlled browser, and the
free-download gates (slices 4–5) need "connect SoundCloud" inside that same browser, so
they would hit the same wall.

Hard rule 1 of this project is that captchas and anti-bot checks are never bypassed,
solved or evaded. Making the browser hide that it is automated is exactly that, so it is
not an option, and the browser-driven design is paused rather than patched.

## What is paused, and why

| Piece | State | Why |
| --- | --- | --- |
| Headed browser session, login script, native adapter, step runner, blocker detector (`apps/worker`, `packages/gates`) | Kept in the repo, switched off in the UI and worker | Refused by SoundCloud's anti-bot check; evading it is against hard rule 1 |
| Free-download gates (Hypeddit, ToneDen…) — slice 4 | Not built | Needs the paused browser |
| AI browser agent — slice 5 | Not built | Needs the paused browser; also the AI provider is undecided (Anthropic was planned; OpenAI was raised) |
| `ANTHROPIC_API_KEY` | Optional env var, unused | Nothing calls an AI API yet |

The paused code is kept because the verification, file naming, job/event schema and
status UI are reused by the plan below, and because the gates question is being
revisited later, not dropped.

## What was built instead (2026-10-05)

Get the most out of what SoundCloud allows, without a browser:

1. **Native downloads via yt-dlp.** `NATIVE_DOWNLOAD_MODE=yt-dlp` (the default). For a
   track whose uploader enabled download, the worker runs `yt-dlp --format download`:
   the uploader's original file, the best quality SoundCloud has. There is no fallback to
   a stream. One track at a time with the existing pauses; a 403/429 fails that track
   and pauses the worker for ten minutes. Each file goes through the existing
   verification and layout, with a `downloads` row. The browser path still exists
   behind `NATIVE_DOWNLOAD_MODE=browser` and is never started otherwise.
2. **Download zip.** `GET /api/playlists/:id/archive` streams a playlist's verified
   files as one stored zip (zip64 when needed); a button on the playlist page.
3. **Buy list stays**; the **Manual list** page now lists gate tracks with their links
   (CSV export) for the owner to complete by hand. *(2026-10-07: both pages, the Evals
   page and the CSV export are gone. Every track's store or gate link is the
   **HQ Download** column of its playlist.)*

## SoundCloud login for downloads (2026-10-06)

**What happened.** The first real yt-dlp run marked all six native tracks of a playlist
**Manual · file gone**. The tracks had not changed: SoundCloud only hands the uploader's
original file to a signed-in account. Asked without a login, its download endpoint
answers 401, yt-dlp prints a warning ("Original download format is only available for
registered users") and then fails with "Requested format is not available". The worker
ran yt-dlp with `--no-warnings`, so it only saw the last line and read it as "file gone".

**Decision (owner).** Downloads run as a SoundCloud account the owner connects, with the
login stored in the local database. The app is for local use only for now. A password
cannot work: yt-dlp does not sign in to SoundCloud with one, and automating SoundCloud's
sign-in page would run into the anti-bot check again (hard rule 1). So the login is the
`oauth_token` cookie, copied from the owner's own signed-in browser.

**What was built.**

- **Connect SoundCloud** page (`/connect`): a step-by-step guide to copying `oauth_token`
  (Chrome/Edge/Brave, Firefox, Safari, troubleshooting), then a paste box. The token is
  checked against api-v2 `/me` before anything is stored; the page shows "Connected as
  …". Opening the app (`/`) lands here until an account is connected; **Skip for now**
  goes to the playlists.
- `soundcloud_account` table (one row) and `/api/soundcloud-account` (GET / PUT /
  DELETE). No response ever carries the token. **Settings** shows the account, with
  **Replace token** and **Disconnect**.
- **Download native tracks** refuses to queue anything (409) until an account is
  connected, and links to the connect page.
- The worker writes the token to a cookie file in `DATA_DIR/tmp` for each yt-dlp run and
  deletes it afterwards (stale ones are removed at start-up). yt-dlp's warnings are kept,
  so an expired or missing login is a retryable **Failed** ("Connect SoundCloud again in
  Settings") instead of **Manual · file gone**.
- Hard rule 5 in CLAUDE.md was rewritten to match.
- **From my SoundCloud** (2026-10-07): the Add playlist dialog has a second source
  next to the pasted URL: a searchable grid of the connected account's own and liked
  playlists, with covers. `GET /api/soundcloud-account/playlists` reads the token from
  Postgres and lists, with the token in the Authorization header (the same way `/me`
  checks it), the signed-in library (`/me/library/all`, the one listing that includes
  the account's private playlists), then the public profile listings
  (`/users/{id}/playlists_without_albums`, `/users/{id}/albums`,
  `/users/{id}/playlists/liked_and_owned`), own ones before likes; the answer never
  carries the token. A private playlist is handed over by its share-token URL, so adding it
  goes through the ordinary ingest. 409 when nothing is connected,
  422 when SoundCloud no longer accepts the token.

The token stops working when that browser signs out of SoundCloud; reconnecting is the
same paste.

## Every track, and a desktop app (2026-10-06 / 2026-10-07)

- **Every track is downloaded** (commit `df3e2c3`): native tracks get the uploader's file
  only; every other track gets the uploader's file if there is one, else the best stream
  the signed-in account can play, with tags and artwork. Tracks SoundCloud only streams
  DRM-protected are marked manual (`drm_protected`); nothing is circumvented. This
  replaces the "left out" note below.
- **Redis removed.** The queue is the `jobs` table: the worker polls for `QUEUED` jobs,
  and its heartbeat is a one-row `worker_heartbeat` table. Postgres is the only service.
- **Desktop app** (`apps/desktop`, Electron): one installer per platform with its own
  Postgres, yt-dlp and ffmpeg, an access code and an end date, for a few friends to test.
  See [DESKTOP.md](DESKTOP.md). The desktop build contains no browser automation.

## Later

- How to approach gates without an automated browser, and whether an AI agent still
  has a place. Nothing is scheduled.
- The slice 4–6 plans in SLICES.md (pause/resume, agent, evals) assume the browser and
  are on hold with it.

## Left out, and why

- **Ripping streams of tracks that are not downloadable** (since built, see above). Asked for on 2026-10-05
  ("download the other tracks with yt-dlp"); not built. For a track the uploader did not
  enable download on, that means pulling the stream and saving it, which SoundCloud's
  terms forbid and which takes something the artist chose not to give away — in the
  `buy` case, the very thing they sell. The assistant declined this part; the owner can
  revisit the decision.
- **Browser automation against SoundCloud** — see above.
- **A second AI provider** — no code depends on one yet; decide when an agent is built.

## Open items for the owner

- Commit and push (or lift the deny rule in `.claude/settings.json`).
- Install `yt-dlp` (on `PATH`, or set `YT_DLP_PATH`), then follow docs/SMOKE.md.
- Wait for the IP flag from 2026-10-02 to cool off before running downloads.
