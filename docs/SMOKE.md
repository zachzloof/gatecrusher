# Manual smoke tests

Anything that touches the live sites is checked by hand, never in `pnpm test` or CI.

## Native downloads with yt-dlp (current default)

**You need:** yt-dlp installed (`yt-dlp --version` works, or `YT_DLP_PATH` points at
it), Docker Desktop running, and a SoundCloud playlist containing at least one track
whose uploader enabled the download button (the track page shows **More → Download
file** to a signed-in visitor). Your network must not be flagged: if an ordinary browser
gets an "unusual activity" warning from SoundCloud, wait before doing this.

### 1. Setup

```sh
pnpm install
docker compose up -d
pnpm db:migrate
```

`.env` must not set `NATIVE_DOWNLOAD_MODE` (or set it to `yt-dlp`).

### 2. Run a real playlist

Two terminals:

```sh
pnpm dev                                  # web  -> http://127.0.0.1:3000
pnpm --filter @gatecrusher/worker start   # worker; logs nativeDownloadMode: yt-dlp
```

1. Open **Playlists → Add playlist**, paste the playlist URL. The downloadable track
   shows **Native** in the Class column and a dash under Status.
2. Click **Download native tracks**. The bar says `Queued 1 track.`
3. **No browser window opens.** The worker log shows `Step started` for
   `yt-dlp-download`, then `Download verified`, then nothing for 8–20 seconds.
4. In the UI the row goes **Queued → Running · yt-dlp-download → Downloaded** without a
   page reload (it polls every 3 seconds while work is in progress).

Expected afterwards:

- `data/downloads/<playlist-slug>/<artist> - <title>.<ext>` exists and **plays** in a
  media player. Its extension matches what the file really is (a WAV upload is `.wav`).
- The bar reads `Downloaded 1 of 1 native track`; **Download native tracks** is disabled.
- **Download zip · 1 file, …** saves `<playlist-slug>.zip`, which extracts to that file.
- With more native tracks, a second click skips the downloaded one.

### 3. What a non-native track does

Add a playlist that also has a gate track and a buy track. Neither gets a job. The gate
track is on **Manual list** with its link; the buy track on **Buy list**. Both pages
export CSV. Nothing is fetched for either, and nothing is fetched for "No download"
tracks: the worker log shows no yt-dlp run for them.

### 4. If a track ends up Manual or Failed

- **Manual · file gone** — the uploader turned the download off since the playlist was
  added. Correct; nothing to do.
- **Manual · dead link** — the track was removed or made private.
- **Failed** with "rate limited or blocked" — SoundCloud answered 403/429. The worker
  pauses for ten minutes. Stop and wait longer before clicking again.
- **Failed** with "yt-dlp is not installed" — install it or set `YT_DLP_PATH`.

## Browser mode (paused — do not run)

The slice 3 path (`NATIVE_DOWNLOAD_MODE=browser`, the login script, the native
adapter) was refused by SoundCloud's anti-bot check on 2026-10-02. It is kept in the
repo and covered by offline tests, but it should not be run against SoundCloud until
that decision is revisited. See [PIVOT.md](PIVOT.md).
