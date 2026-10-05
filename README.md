# Gatecrusher

Personal-use web app that takes a SoundCloud playlist, classifies every track (native
download / free-download gate / buy / none), completes the free-download gates with a
dedicated burner account in a visible browser, and hands over to you whenever a step
needs a human.

**Status (2026-10-05): browser automation paused; yt-dlp for native tracks.** Paste a
SoundCloud playlist URL and every track is stored and classified. Tracks whose uploader
enabled SoundCloud's own download are fetched with yt-dlp (no browser), verified, and
bundled into one zip per playlist. Gate tracks and buy tracks are listed with their links
for you to handle by hand. Why, and what is paused: [docs/PIVOT.md](docs/PIVOT.md).

## What runs where

| Piece                      | Runs                      | Started with                            |
| -------------------------- | ------------------------- | --------------------------------------- |
| Postgres, Redis            | Docker Compose            | `docker compose up -d`                  |
| Web (UI + API), `apps/web` | natively, with hot reload | `pnpm dev`                              |
| Worker, `apps/worker`      | **natively, always**      | `pnpm --filter @gatecrusher/worker dev` |

The worker is never containerised. In today's default mode it runs yt-dlp, no browser.
(The paused browser mode would need a visible window and refuses to start headless.)

## 5-minute local setup

The longer, step-by-step version with troubleshooting is
[docs/INITIAL-SETUP.md](docs/INITIAL-SETUP.md).

Prerequisites: **Node 24+**, **pnpm 12** (`npm install --global pnpm@12`), **Docker
Desktop** running. Optional: [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH`
(or `YT_DLP_PATH` in `.env`) — see [Adding a playlist](#adding-a-playlist).

```sh
# 1. Install dependencies
pnpm install

# 2. Create your env file. The defaults match docker-compose.yml.
cp .env.example .env            # PowerShell: Copy-Item .env.example .env

# 3. Start Postgres and Redis (only those two start by default)
docker compose up -d

# 4. Create the tables, and optionally add a fake playlist with four fake tracks
pnpm db:migrate
pnpm db:seed

# 5. Start web  ->  http://127.0.0.1:3000
pnpm dev
```

Then, **in a second terminal on the host**, start the worker:

```sh
pnpm --filter @gatecrusher/worker dev
```

It validates its environment, connects to Postgres and Redis, and logs
`Worker ready, waiting for jobs`. Within a few seconds the "Worker offline" banner in
the UI disappears. Stop it with Ctrl+C; it shuts down cleanly and the banner returns.

To prove the queue round-trip, send it a no-op job from a third terminal:

```sh
pnpm --filter @gatecrusher/worker enqueue-ping
```

The worker logs `Processed ping job` and the command prints the worker's answer.

### Adding a playlist

On **Playlists**, click **Add playlist** and paste a URL like
`https://soundcloud.com/artist/sets/name`. Gatecrusher reads the playlist through
SoundCloud's api-v2 (it finds the `client_id` the SoundCloud site itself uses, caches it
in memory, and looks it up again if SoundCloud rejects it), stores the tracks and
classifies each one:

| Classification  | Meaning                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| **Native**      | SoundCloud's own download button is enabled                                 |
| **Gate**        | The track's link goes to a free-download gate or file host (platform shown) |
| **Buy**         | The link goes to a store; listed on **Buy list**, exportable as CSV         |
| **No download** | No usable link                                                              |

Adding the same playlist again updates it in place. If api-v2 cannot be used,
Gatecrusher falls back to `yt-dlp -J` for the track list and the playlist page says so.
yt-dlp reports no download or buy links, so those tracks all show as **No download**
until the playlist is added again with api-v2 working. Without yt-dlp installed the
fallback is simply unavailable.

### Downloading native tracks

You need [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH` (or `YT_DLP_PATH`
in `.env`). With the worker running, open a playlist and click **Download native
tracks**. For every track whose uploader enabled SoundCloud's own download, the worker
asks yt-dlp for that file — the uploader's original, the best quality SoundCloud has —
one track at a time, with a pause between tracks. Nothing else is fetched: a track
without an uploader-enabled download is never pulled from its stream.

Each file is verified (size, and content sniffed from its bytes as audio or a zip
containing audio) before it counts, and lands in
`data/downloads/<playlist-slug>/<artist> - <title>.<ext>`. Tracks already downloaded
are skipped on the next click; failed ones are retried. If SoundCloud answers 403 or
429, the worker marks that track failed and takes no jobs for ten minutes.

**Download zip** on the playlist page bundles every verified file of that playlist into
one archive, streamed straight from disk.

**Buy list** and **Manual list** hold the tracks with a store link or a free-download
gate link, each exportable as CSV, for you to handle in your own browser.

The manual check is in [docs/SMOKE.md](docs/SMOKE.md).

### If a port is already taken

Everything is published on `127.0.0.1` only. If another project already uses a port,
change it in `.env`:

| Service            | Variable        | Also update                |
| ------------------ | --------------- | -------------------------- |
| Postgres           | `POSTGRES_PORT` | the port in `DATABASE_URL` |
| Redis              | `REDIS_PORT`    | the port in `REDIS_URL`    |
| Web in Docker only | `WEB_PORT`      | nothing                    |

The native dev server takes its port from the shell, not from `.env`. Check the URL
`pnpm dev` prints, or choose one yourself:

```sh
PORT=3001 pnpm dev              # PowerShell: $env:PORT = 3001; pnpm dev
```

Then `docker compose up -d` again.

## Environment

One `.env` in the repo root serves web, worker, the database scripts and Docker
Compose. [.env.example](.env.example) documents every variable. Web and worker
validate it at startup and exit with a message naming whatever is missing or malformed
(never its value). The **Settings** page shows which variables are set — never their
values.

## Commands

| Command                                   | What it does                                                    |
| ----------------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                                | Web with hot reload, on `127.0.0.1:3000`                        |
| `pnpm --filter @gatecrusher/worker dev`   | Worker, restarting on file changes                              |
| `pnpm --filter @gatecrusher/worker start` | Worker, without the file watcher                                |
| `pnpm build`                              | Production build                                                |
| `pnpm lint`                               | ESLint across the workspace                                     |
| `pnpm typecheck`                          | `tsc --noEmit` across the workspace                             |
| `pnpm test`                               | Unit + integration tests (needs `docker compose up -d`)         |
| `pnpm test:unit`                          | Unit tests only, no services needed                             |
| `pnpm test:e2e`                           | Playwright UI tests (headless; no services needed)              |
| `pnpm format`                             | Prettier                                                        |
| `pnpm db:generate`                        | Generate a migration after changing `packages/db/src/schema.ts` |
| `pnpm db:migrate`                         | Apply pending migrations                                        |
| `pnpm db:seed`                            | Insert / refresh the fake seed playlist                         |

First time running the tests: `pnpm --filter @gatecrusher/web exec playwright install chromium`
(the adapter and worker integration tests and the UI e2e all use it, headless).

Integration tests use the Postgres and Redis from your `.env`, but never your data: the
database and API tests create and drop their own throwaway databases, and the queue test
uses a throwaway key prefix. Nothing in `pnpm test` reaches SoundCloud: ingest is tested
against recorded fixtures, and the native adapter against hand-written fixture pages on a
local server whose network guard fails any request that leaves localhost. e2e starts its own web server on port 3100 and fakes the API
in the browser, so it needs no database.

## Running web in Docker

Day to day, web runs natively. Two Docker options exist:

```sh
# Production-style: build the image and run it next to Postgres and Redis
docker compose --profile web up -d --build

# Hot reload inside a container (repo bind-mounted)
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile web up --build
```

Both serve on `http://127.0.0.1:3000` (`WEB_PORT`). Run `pnpm db:migrate` from the host
first. The worker still runs on the host either way.

## Repository layout

```
apps/web         Next.js App Router UI and API route handlers
apps/worker      BullMQ worker, the headed Playwright browser, the login script
packages/core    Shared types, zod schemas, track classifier, CSV, job state machine. No I/O
packages/db      Drizzle schema, migrations, repository functions, seed
packages/gates   Step runner, registry, blocker detector, download verification, adapters
```

The Node services run TypeScript directly through Node's built-in type stripping, so
there is no build step for the worker or the packages.

## Rules this project keeps

Never bypass or solve captchas; hand every blocker to the human and resume from the
same step; only mark a track manual when it is genuinely impossible; never purchase
anything; only the burner account; behave like a slow human. The full list is in
[CLAUDE.md](CLAUDE.md).
