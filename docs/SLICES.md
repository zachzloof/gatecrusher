# Build slices

Six slices, built in order. Each follows the workflow in [CLAUDE.md](../CLAUDE.md): restate the plan -> build -> `pnpm lint && pnpm typecheck && pnpm test` -> run the `review` skill -> summarise what to run and click.

A slice is done only when all of its acceptance criteria are met and the "done" checklist in `.claude/skills/testing/SKILL.md` passes.

---

## Slice 1 — Scaffold

Monorepo, DB schema, Docker Compose, natively-run worker, CI workflow, empty UI shell with nav.

**Acceptance criteria**

- [ ] pnpm workspace + Turborepo with `apps/web`, `apps/worker`, `packages/db`, `packages/core`, `packages/gates`; shared strict `tsconfig`, ESLint, Prettier
- [ ] Root scripts work: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:unit`, `pnpm test:e2e`
- [ ] Drizzle schema + initial migration for `playlists`, `tracks`, `runs`, `jobs`, `events`, `downloads`, `human_requests`, with foreign keys, indexes, and enums for classification and job status
- [ ] `pnpm db:migrate` applies cleanly to an empty database; a test proves it
- [ ] `docker compose up` starts Postgres and Redis with health checks; `docker compose --profile web up` additionally builds and starts web, reachable in the browser
- [ ] `pnpm dev` runs web natively against the Compose Postgres and Redis
- [ ] Worker starts natively with `pnpm --filter @gatecrusher/worker dev`, validates env, connects to Postgres and Redis, processes a no-op `ping` job, and logs with pino
- [ ] Env validated with zod at startup in web and worker; `.env.example` complete; bad env exits with a clear message
- [ ] `.gitignore` covers `.env*` (not `.env.example`), `data/`, build output, Playwright artefacts
- [ ] UI shell: dark theme with the design tokens from `frontend-design`, nav (Playlists, Runs, Buy list, Manual list, Evals, Settings), each page showing its empty state; responsive at 375 / 768 / 1280px
- [ ] `/api/health` reports DB, Redis, and worker-heartbeat status; the shell shows a "worker offline" banner when there is no heartbeat
- [ ] GitHub Actions workflow runs lint, typecheck, unit + integration tests (Postgres/Redis services), and UI e2e
- [ ] One e2e test: shell loads, nav works
- [ ] `core` contains the job state `transition()` function with an exhaustive table test

---

## Slice 2 — Ingest + classify

Resolve a SoundCloud playlist, persist tracks, classify each one. UI: paste URL, tracks table, buy list, CSV export.

**Acceptance criteria**

- [ ] Paste a playlist URL -> playlist resolved through the api-v2 `resolve` endpoint using a resolved `client_id`; `client_id` is discovered at runtime, cached, and re-resolved on 401/403
- [ ] Playlists longer than the first page are fully hydrated (track stubs fetched in batches)
- [ ] If api-v2 fails, falls back to `yt-dlp -J` for metadata (invoked with an argument array, output zod-validated); the UI shows which source was used
- [ ] Tracks persisted idempotently: re-ingesting the same playlist updates rather than duplicates, and keeps existing downloads
- [ ] Each track classified `native` / `gate` / `buy` / `none` by a pure function in `core` using `purchase_url`, `purchase_title`, and `downloadable` flags; gate platform recorded (hypeddit, toneden, ..., unknown)
- [ ] Classifier is table-tested with at least 30 cases, including: "Free Download" title pointing at a store, buy title pointing at a gate, downloadable + purchase_url both set, missing/empty/malformed URLs, URL shorteners
- [ ] Invalid, private, or non-playlist URLs produce a clear inline error, not a crash
- [ ] Tracks table: artwork, title/artist, classification, gate platform, duration, link; sortable, filterable by classification; empty/loading/error states; responsive
- [ ] Buy list view shows store, title, artist, link; **Export CSV** downloads a correctly escaped file
- [ ] All external responses pass through zod; ingest tests run offline against recorded fixtures
- [ ] e2e: paste URL (faked ingest) -> table renders -> filter -> export CSV
- [ ] Nothing in this slice opens a browser or downloads audio

---

## Slice 3 — Browser runtime

Headed persistent Playwright profile with the burner login, native download adapter, download verification, downloads layout, basic run for native tracks only.

**Acceptance criteria**

- [ ] `pnpm --filter @gatecrusher/worker run login` opens headed Chromium on the persistent profile at the SoundCloud sign-in page, waits for the user to log in by hand, confirms the session, and exits. No credentials are read, stored, or logged by app code
- [ ] Worker launches the same profile headed; refuses to start in headless mode; reports "not logged in" as a `needs_human` condition rather than failing
- [ ] `GateAdapter`, `GateStep`, `GateContext`, `StepResult` defined in `core`; step runner and adapter registry in `gates`
- [ ] Central delay provider with randomised ranges; adapters cannot act without it; a zero-delay fake is used in tests
- [ ] Native SoundCloud adapter written as resumable steps: open track -> open "More" -> Download -> capture file
- [ ] Download verification: file exists, size above `MIN_DOWNLOAD_BYTES` (env, default 1 MB), content sniffed as audio or as a zip containing at least one audio entry above the threshold; archives kept as delivered and recorded as `archive`; failures never mark success; partial files cleaned up
- [ ] Files saved as `data/downloads/<playlist-slug>/<artist> - <title>.<ext>` with sanitised names and collision handling; a `downloads` row with size, MIME, checksum
- [ ] "Run native tracks" on a playlist processes native tracks sequentially (one at a time, delays between); already-verified tracks are skipped
- [ ] Each step writes events with status, step name, and screenshot path
- [ ] Shared blocker detector (captcha / login challenge / unexpected page) exists and is called after every step; in this slice a detection parks the job as `WAITING_FOR_HUMAN` and is shown as a plain status with the description and screenshot; clicking "Run native tracks" again retries parked tracks (the Continue / Give up flow and Needs-you cards arrive in slice 4)
- [ ] Fixture pages for the native flow incl. captcha, removed track, download-disabled; integration tests cover happy path, verification failure, and blocker detection — all offline
- [ ] Manual smoke steps documented: login, run a real playlist with one native track, confirm the file plays

---

## Slice 4 — Queue + Hypeddit + pause/resume

BullMQ jobs per track, Hypeddit adapter as resumable steps, captcha detection, `WAITING_FOR_HUMAN`, live run page over SSE, Needs-you cards, retry.

**Acceptance criteria**

- [ ] Starting a run creates one BullMQ job per downloadable track; worker concurrency is 1 with randomised delay between jobs; `buy`/`none` tracks get no job
- [ ] Hypeddit adapter implemented as resumable steps (open gate, connect SoundCloud, each required follow/like/repost/comment action, unlock, download), every step re-entrant with an "already satisfied" check
- [ ] Blockers are checked after every step and on popups; captcha / email confirmation / login challenge / unexpected page all yield `needs_human`, never `FAILED` or `MANUAL`
- [ ] On `needs_human`: screenshot taken, `human_requests` row + event + checkpoint written in one transaction, job is `WAITING_FOR_HUMAN`, the tab stays open, and **the next job starts** while it is parked
- [ ] Parked-page cap enforced; at the cap gate jobs pause and the UI explains why
- [ ] Continue -> high-priority resume job -> same page, same step. Covered: blocker cleared, blocker still present (re-park, attempt+1), page lost (new tab, steps self-skip)
- [ ] Give up -> job `MANUAL` with `user_gave_up`, reason and link stored, tab closed
- [ ] Continue and Give up are idempotent
- [ ] Worker restart: `RUNNING` jobs re-queued from their checkpoint; `WAITING_FOR_HUMAN` jobs keep their state with session marked lost; no job is lost or double-run
- [ ] Parked-tab TTL closes the tab but leaves the job `WAITING_FOR_HUMAN`
- [ ] Run page: per-track live status and current step over SSE; reconnect/refresh replays state from Postgres; "live updates paused" banner on disconnect
- [ ] Needs-you cards per the `frontend-design` pattern: instruction, screenshot (enlargeable), step indicator, Continue, Give up (confirm); nav counter; document title count
- [ ] Retry button re-queues `FAILED` jobs
- [ ] Dead gate / removed file -> `MANUAL` with the right reason and link
- [ ] Hypeddit fixtures: happy path, captcha iframe at a mid step, captcha cleared, dead link, file gone, login challenge, unexpected page; all `gate-adapter` and `human-in-the-loop` test cases pass offline
- [ ] e2e (fake worker): live status updates, Needs-you card appears, Continue and Give up flows, Retry
- [ ] Manual smoke steps documented for one real Hypeddit gate

---

## Slice 5 — AI agent fallback

Browser-agent adapter for unknown gates, `request_human` wired into the same pause/resume flow, action log with screenshots, cost/step counters, give-up reasons.

**Acceptance criteria**

- [ ] Agent adapter registered with the lowest priority; a registry test proves specific adapters always win and unknown gates fall through to it
- [ ] Anthropic SDK tool-use loop with zod-validated tools: `screenshot`, `click`, `type`, `scroll`, `navigate`, `request_human`, `finish`, `give_up`
- [ ] Code-level guardrails: captcha/anti-bot present -> action not executed, job goes `needs_human` regardless of model output; clicks on captcha frames or purchase controls refused; `navigate` restricted to http(s) public hosts; credentials never typed
- [ ] `request_human` uses exactly the slice-4 flow (same event, same card, same Continue/Give up); resume starts a fresh conversation from a persisted summary + new screenshot with counters carried over
- [ ] Stop conditions implemented: verified `finish`, unverified `finish` handling, `give_up`, max steps, cost ceiling, loop detection — step/cost limits end in `needs_human`, not failure
- [ ] Success is decided only by download verification, never by the model's claim
- [ ] `give_up` reasons limited to `dead_link` / `file_gone` / `account_required`, stored with detail and link
- [ ] Every action logged as an `agent_action` event with screenshot path, token counts, and cost; cumulative steps and cost stored per job
- [ ] UI: expandable action log per track (thumbnail, action description, tokens, cost), step and cost counters live on the run page, give-up reason shown
- [ ] Model ID, max steps, and cost ceiling come from validated env; API key never logged
- [ ] A setting to disable the agent entirely (unknown gates then park as `needs_human` for the user to complete by hand)
- [ ] All `browser-agent` test cases pass with a scripted fake client — no real API calls in `pnpm test`
- [ ] Manual smoke steps documented for one real unknown gate, including expected cost

---

## Slice 6 — Manual list + evals + deploy

True manual list, in-app run status, evals page, production setup and deploy notes. No push, browser, or outbound notifications — the user checks the app.

**Acceptance criteria**

- [ ] Manual list page: every `MANUAL` track across runs with reason, detail, gate link, SoundCloud link, when it happened; filter by reason and playlist; CSV export; "Retry" to re-queue and "Mark as done" to dismiss
- [ ] A test proves no code path produces `MANUAL` without a reason and link, and that only the four allowed reasons exist
- [ ] Run state is obvious on opening the app: Runs list shows each run as running / finished / finished-waiting-on-you with counts, and the nav Needs-you counter and document-title count are accurate on first load (no notifications of any kind are sent)
- [ ] Run summary: downloaded / buy / manual / needs-you counts, with links to each list
- [ ] Evals page: per gate platform — attempts, success rate, human-intervention rate, manual rate broken down by reason, median time per track; for the agent also average steps and cost per track; filter by date range
- [ ] Evals are computed from the events/jobs tables by tested query functions; charts follow the dark design tokens and have empty states
- [ ] Production setup: production Compose file (web built image, persistent volumes, restart policies, health checks), migration-on-deploy step, documented backup/restore for Postgres
- [ ] Worker run instructions for the host: start on login, graceful shutdown, log location, updating; documented for the user's OS
- [ ] `docs/DEPLOY.md` covers: prerequisites, first-time setup incl. the login script, env reference, start/stop, upgrading, troubleshooting (expired `client_id`, logged-out burner, stuck parked tabs, Redis/Postgres down)
- [ ] The web UI's network exposure is an explicit, documented decision (localhost-only by default; any LAN/remote access gated)
- [ ] Full regression: all suites green; an end-to-end manual pass on a real mixed playlist is documented with results
