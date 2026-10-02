# Manual smoke tests

Anything that touches the live sites and the burner account is checked by hand, never in
`pnpm test` or CI. Each slice adds its steps here.

## Slice 3 — native SoundCloud download

**You need:** the burner SoundCloud account's credentials, Docker Desktop running, and a
SoundCloud playlist that contains at least one track with SoundCloud's own download
button enabled (the track page shows **More → Download file** when you are signed in).

### 1. One-time setup

```sh
pnpm install
pnpm --filter @gatecrusher/worker exec playwright install chromium
docker compose up -d
pnpm db:migrate
```

### 2. Log the burner account in

The worker must **not** be running: a browser profile can only be open in one browser.

```sh
pnpm --filter @gatecrusher/worker login
```

- A Chromium window opens on SoundCloud's sign-in page.
- Sign in with the **burner** account by hand (solve any captcha yourself).
- The script notices the signed-in header, reloads SoundCloud to confirm the session
  holds, logs `Logged in. The session is saved in the browser profile.` and closes the
  window.

Expected: exit code 0, and `data/browser-profile/` now exists. Nothing you typed appears
in the terminal output. Running the command again finishes within a few seconds without
asking you to sign in.

If it times out although you did sign in, SoundCloud has changed its header: the
selector to update is `signedInNav` in `packages/gates/src/native/locators.ts`.

### 3. Run a real playlist

Three terminals:

```sh
pnpm dev                                  # web  -> http://127.0.0.1:3000
pnpm --filter @gatecrusher/worker start   # worker (no browser window yet)
```

1. Open **Playlists → Add playlist**, paste the playlist URL. The native track shows
   **Native** in the Class column and a dash under Status.
2. Click **Run native tracks**. The bar says `Queued 1 track.`
3. A Chromium window opens. Watch it: the track page loads, it pauses a few seconds,
   opens **More**, pauses, clicks **Download file**.
4. In the UI the row goes **Queued → Running · open-track → … → Downloaded** without a
   page reload (it polls every 3 seconds while work is in progress).

Expected afterwards:

- `data/downloads/<playlist-slug>/<artist> - <title>.<ext>` exists and **plays** in a
  media player. Its extension matches what the file really is (a WAV upload is `.wav`).
- `data/screenshots/<run-id>/<job-id>/` holds one PNG per step.
- **Run native tracks** is disabled (`Downloaded 1 of 1 native track`). With more native
  tracks in the playlist, it is enabled and a second click skips the downloaded one.
- The worker log shows `Step started` / `Step finished` for `open-track`, `open-more`,
  `download`, then `Download verified`, then nothing for 8–20 seconds (the pause between
  tracks).

### 4. The not-logged-in path

1. Stop the worker. Delete `data/browser-profile/` (or sign out in the login window).
2. Start the worker and click **Run native tracks** on a playlist with a native track
   that is not downloaded yet.

Expected: the track becomes **Needs you**, a **Paused** section shows "The burner account
is not signed in to SoundCloud…" with a screenshot, and the worker's tab stays open on
the track page. Sign in **in that window**, click **Run native tracks** again: the same
tab carries on and the file downloads. The job never shows Failed or Manual.

### 5. If a step parks as "did not load as expected"

That is the adapter saying the page is not what it knows — most likely SoundCloud
changed its markup. Compare the screenshot with the selectors in
`packages/gates/src/native/locators.ts` (one file, six selectors) and update them and the
matching fixture pages in `packages/gates/src/native/__fixtures__/`.

### Known gaps in this slice

- No Continue / Give up buttons and no live updates over SSE: retrying a paused track is
  "click Run native tracks again", and the page polls. Both arrive in slice 4.
- Closing the worker closes its browser, so paused tabs are lost; the next retry starts
  those tracks again on a new tab. Full restart reconciliation is slice 4.
- zip64 archives (over 4 GB, or more than 65 535 entries) are not accepted by
  verification; such a download parks for you to look at.
