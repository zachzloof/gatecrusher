# Initial setup

From a fresh clone to downloading a playlist. Windows is assumed (PowerShell commands
where they differ); everything also works on macOS and Linux.

The current mode of the app is **no browser automation**: native tracks are fetched
with yt-dlp, gate and buy tracks are listed for you to handle by hand. Why that is, and
what is paused: [PIVOT.md](PIVOT.md).

## 1. Prerequisites

| Tool | Version | Check | Install |
| --- | --- | --- | --- |
| Node | 24 or newer | `node --version` | [nodejs.org](https://nodejs.org) |
| pnpm | 12 | `pnpm --version` | `npm install --global pnpm@12` |
| Docker Desktop | any recent | `docker ps` (must not error) | [docker.com](https://www.docker.com/products/docker-desktop/) |
| yt-dlp | any recent | `yt-dlp --version` | with Python: `py -m pip install --upgrade yt-dlp` (macOS/Linux: `python3 -m pip install --upgrade yt-dlp`) |

Docker Desktop must be **running** before step 4; starting it from the Start menu is
enough. If `winget install yt-dlp` was tried and `yt-dlp --version` still fails, use the
pip command above (`winget list --id yt-dlp.yt-dlp` says whether winget installed
anything at all).

## 2. Install the workspace

```sh
git clone https://github.com/zachzloof/gatecrusher.git
cd gatecrusher
pnpm install
```

## 3. Create `.env`

```sh
cp .env.example .env            # PowerShell: Copy-Item .env.example .env
```

The defaults work as they are. Change only what you need:

- **A port is already in use** (another project's Postgres on 5432, something on 3000):
  set `POSTGRES_PORT=55432` and change the port inside `DATABASE_URL` to match. The web
  dev server's port comes from the shell, not `.env`: `$env:PORT = 3001; pnpm dev`.
- **yt-dlp is not on your PATH:** set `YT_DLP_PATH` to its full path.
- Leave `NATIVE_DOWNLOAD_MODE` and `HEADLESS` unset. `NATIVE_DOWNLOAD_MODE=browser` turns
  the paused browser path back on; don't.
- `ANTHROPIC_API_KEY` can stay empty; nothing uses it.

Every variable is documented in [.env.example](../.env.example). The **Settings** page
in the app shows which ones are set (never their values).

## 4. Start Postgres and Redis

```sh
docker compose up -d
docker ps          # both gatecrusher containers should say "healthy" within ~20 s
```

Only those two containers start; web and the worker run natively.

## 5. Create the tables

```sh
pnpm db:migrate
pnpm db:seed       # optional: one fake playlist with four fake tracks, to see the UI
```

`pnpm db:migrate` is safe to run again after pulling changes that add a migration.

## 6. Run it

Two terminals, left open:

```sh
pnpm dev                                  # web  -> http://127.0.0.1:3000
pnpm --filter @gatecrusher/worker start   # worker; logs "nativeDownloadMode": "yt-dlp"
```

Open http://127.0.0.1:3000. The banner at the top disappears once the worker's
heartbeat arrives (a few seconds). If it says Postgres or Redis is down, go back to
step 4.

## 7. Connect SoundCloud

The first time, the app opens on **Connect SoundCloud**. SoundCloud only hands an
uploader's file to a signed-in account, so downloads run as an account you connect here.
Use a burner account rather than your main one.

The page walks you through it: sign in on soundcloud.com in your normal browser, open the
developer tools (F12), find the `oauth_token` cookie under soundcloud.com, copy its value
and paste it into the box. Gatecrusher checks it with SoundCloud, then shows
"Connected as …". It never asks for your password. **Skip for now** is fine for adding
playlists; downloading asks for the account first.

The token is stored in the local database only. **Settings → SoundCloud account** shows
who is connected, with **Replace token** and **Disconnect**. Signing out of SoundCloud in
that browser ends the token; connect again with a fresh one.

## 8. First playlist

1. **Playlists → Add playlist**, paste a URL like `https://soundcloud.com/artist/sets/name`.
   Every track is classified: **Native** (the uploader enabled SoundCloud's download),
   **Gate** (a free-download gate link), **Buy** (a store link), **No download**.
2. **Download native tracks.** The worker fetches the native ones one at a time, a pause
   between each, and verifies every file. Rows go Queued → Running → Downloaded.
3. **Download zip** bundles the playlist's verified files into one archive. Files also
   sit in `data/downloads/<playlist-slug>/`.
4. **Buy list** and **Manual list** (gate tracks) have the links to handle yourself, each
   with **Export CSV**.

Don't run step 2 while SoundCloud is showing your network an "unusual activity"
warning in an ordinary browser; wait for that to clear first.

## 9. Day to day

| Want to | Run |
| --- | --- |
| Stop everything | Ctrl+C in both terminals; `docker compose stop` |
| Start again | `docker compose up -d`, then the two commands from step 6 |
| Run the checks | `pnpm lint && pnpm typecheck && pnpm test` (needs the containers up) |
| UI e2e | `pnpm test:e2e` (first time: `pnpm --filter @gatecrusher/web exec playwright install chromium`) |
| Update yt-dlp | `py -m pip install --upgrade yt-dlp` — SoundCloud changes break old versions |

## Troubleshooting

- **`docker ps` errors with "cannot connect to the Docker daemon"** — Docker Desktop is
  not running. Start it and wait for its whale icon to settle.
- **`pnpm db:migrate` cannot connect** — the port in `DATABASE_URL` must be the one
  `docker ps` shows for `gatecrusher-postgres-1` (e.g. `127.0.0.1:55432->5432`).
- **A track fails with "yt-dlp is not installed"** — `yt-dlp --version` in a *new*
  terminal; if it works there, restart the worker so it sees the updated PATH; otherwise
  set `YT_DLP_PATH`.
- **A track fails with "rate limited or blocked"** — SoundCloud answered 403/429. The
  worker pauses for ten minutes on its own. Stop and wait longer before clicking again.
- **A track fails with "Connect SoundCloud again in Settings"** — the saved token
  expired or that browser signed out of SoundCloud. Copy a fresh `oauth_token` (step 7),
  paste it under **Settings → SoundCloud account → Replace token**, then click
  **Download native tracks** again.
- **Every native track went to Manual · file gone** — that was the symptom before the
  SoundCloud login existed. Connect an account, then click **Download native tracks**:
  tracks marked Manual are tried again.
- **`pnpm --filter @gatecrusher/worker login` shows an npm QR code** — that's pnpm's own
  `login` command, not ours. The script is `run login`, and it belongs to the paused
  browser mode; you don't need it.
- **Something still opens a browser window** — it shouldn't. Check `.env` has no
  `NATIVE_DOWNLOAD_MODE=browser`, and tell me.
