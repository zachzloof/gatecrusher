# Gatecrusher

> **Status (2026-10-05): browser automation is paused.** SoundCloud's anti-bot check
> refused the Playwright browser, and hard rule 1 forbids evading it. Native downloads
> now go through yt-dlp (`NATIVE_DOWNLOAD_MODE=yt-dlp`, the default); the browser path
> stays in the repo but only runs with `NATIVE_DOWNLOAD_MODE=browser`. Gates are listed
> for the owner to do by hand. **Do not launch a browser or make requests against
> SoundCloud or gate sites from this machine while working on the code.** Points 2–4
> below describe the original plan, not what runs today. See [docs/PIVOT.md](docs/PIVOT.md).
>
> **2026-10-06:** SoundCloud only hands the uploader's file to a signed-in account, so
> yt-dlp now runs with a login token the owner pastes on the **Connect SoundCloud**
> page (`/connect`). See hard rule 5.

Personal-use web app (single user, built to professional standards). It takes a SoundCloud playlist URL and:

1. Classifies every track: **native** SoundCloud download / **gate** (third-party free-download gate such as Hypeddit, ToneDen) / **buy** (Bandcamp, Beatport, ...) / **none**.
2. Completes free-download gates automatically with a dedicated burner SoundCloud account, driving a visible browser via Playwright.
3. Falls back to an AI browser agent (Anthropic API) for unknown gates.
4. Pauses and hands over to the human whenever a step needs one (captcha, email confirmation, login challenge, unexpected page), then resumes from the same step.
5. Leaves a **buy list** and a short **manual list** for whatever is genuinely impossible.

Files land in a local download folder. The worker runs on a machine the user controls with a headed browser so they can act in the real window when asked.

Deeper docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SLICES.md](docs/SLICES.md). Skills live in `.claude/skills/`.

## Hard rules

These are not negotiable. If a task seems to require breaking one, stop and ask.

1. **Never bypass, solve, or automate captchas or anti-bot checks.** No solver services, no clicking "I'm not a robot", no audio-challenge tricks, no stealth/fingerprint-evasion plugins. Detect it and hand it to the human.
2. **Human-in-the-loop, never fail.** Adapters must never fail on a captcha, email-confirmation step, login challenge, or unexpected page. They:
   - detect it,
   - emit a `needs_human` event with a screenshot and a short description of what is needed,
   - park the job in `WAITING_FOR_HUMAN` **without blocking the rest of the queue**,
   - resume **from the same step** when the user clicks Continue in the UI.
   The browser page stays open on that page the whole time.
3. **Manual means genuinely impossible.** Only mark a track `MANUAL` for: dead link, file gone, requires an account we don't have, or the user clicked Give up. Always store a reason and the link.
4. **Never auto-purchase anything.** Buy links go to the buy list. Never click a pay/checkout/add-to-cart control.
5. **SoundCloud login is a token the owner pastes in; never a password.** (Changed by the owner on 2026-10-06 for local use; it used to say credentials live only in the browser profile.) The owner signs in on soundcloud.com in their own browser, copies the `oauth_token` cookie, and pastes it on `/connect`. A burner account is recommended. The token:
   - is stored only in the local Postgres (`soundcloud_account`, one row), after SoundCloud has accepted it;
   - reaches yt-dlp only through a temporary cookie file in `DATA_DIR/tmp`, deleted when the job ends; never on a command line;
   - is never logged, printed, returned by an API, shown in the UI, or put in an error message.

   Never ask for, store or automate a SoundCloud password or sign-in. The paused browser mode keeps its own interactive login in the browser profile.
6. **Behave like a slow human.** Concurrency 1 for browser jobs, randomised delays between actions, real persistent browser profile, **no headless mode** in the worker. (Headless is fine for Playwright *tests* against local fixtures and the UI.)

## Stack (decided — ask before adding anything outside it)

- **Monorepo:** pnpm workspaces + Turborepo. TypeScript `strict` everywhere.
- **`apps/web`** — Next.js (App Router, Tailwind, shadcn/ui). Serves the UI and the API route handlers (including the SSE endpoint).
- **`apps/worker`** — Node service running BullMQ jobs with Playwright (headed, persistent profile).
- **`packages/db`** — Drizzle ORM + Postgres schema and migrations.
- **`packages/core`** — shared types, zod schemas, gate classifier, adapter interfaces, result types.
- **`packages/gates`** — gate adapters + the AI browser agent.
- **Redis** — BullMQ queue and pub/sub for live events.
- **Docker Compose** — Postgres, Redis, web. **The worker runs natively on the host** so its browser window is visible. The `web` service sits behind the Compose profile `web` and is for the production setup; day to day, `docker compose up` starts only Postgres and Redis and web runs natively with `pnpm dev`.
- **Tooling:** ESLint + Prettier, Vitest, Playwright Test, pino.

Dependency direction: `apps/*` -> `packages/gates` -> `packages/core`; `packages/db` -> `packages/core`. `core` imports nothing from the workspace. `gates` never imports `db` — it reports through the `ctx` it is given.

## Architecture principles

- **One adapter interface.** Every gate implements `GateAdapter`: `detect(url)` and `run(ctx) -> Result`. `run` is written as an ordered list of **resumable steps** so a job can pause at any step and continue from it.
- **The AI agent is just another adapter** with the lowest priority in the registry. It gets no special paths through the worker.
- **Structured events for everything.** Every job writes events (`status`, `step`, `screenshot path`, `error`, `needs_human` details) to Postgres and publishes them so the UI can show live progress.
- **Verify every download** before marking success: file exists, size above `MIN_DOWNLOAD_BYTES` (default 1 MB), and the content (sniffed from bytes, not the extension) is either audio or a zip archive containing at least one audio entry above the same threshold. Archives are kept as delivered and recorded as `archive` in `downloads`.
- **State lives in Postgres.** Redis is transport. In-memory state (open pages) is a cache that must be recoverable — see the human-in-the-loop skill.

## Coding standards

- Small modules, one responsibility each. Prefer pure functions in `core`.
- No `any`. No non-null `!` without a comment explaining why. `unknown` + zod parse instead.
- **zod at every boundary:** HTTP input/output, queue payloads, event payloads, env, external API responses, AI tool inputs.
- **Result types, not thrown errors, in adapters** (`{ ok: true, ... } | { ok: false, kind, reason }`). Throwing is reserved for programmer errors; the worker catches at the job boundary and records a `FAILED` (retryable) event.
- **Structured logging with pino.** Log objects, not interpolated strings. Redact `password`, `cookie`, `authorization`, `token`, `apiKey`. Never log page HTML from login pages.
- **Env validated at startup** with zod; the process exits with a readable message if invalid.

## Testing

- **Vitest** for unit and integration tests.
- **Playwright Test** for e2e of the UI.
- **Fixture HTML pages** for gate adapters so they are testable offline, including fixtures containing a captcha iframe to exercise the pause/resume path. Tests never hit live SoundCloud or gate sites.
- Every slice ships with tests. `pnpm lint && pnpm typecheck && pnpm test` must pass before a slice is called done.

## Workflow

Work in slices (see [docs/SLICES.md](docs/SLICES.md)). For each slice:

1. **Restate the plan** — what will be built, files touched, open questions. Wait for a go-ahead if anything is ambiguous.
2. **Build.**
3. **Run the checks** — `pnpm lint && pnpm typecheck && pnpm test`.
4. **Run the `review` skill** and fix what it finds.
5. **Summarise** exactly what to run and what to click to verify.

Also:

- **Ask before adding a dependency** that is not in the stack above.
- **Do not commit, create branches, or push.** The user handles git.
- Use the matching skill when the work touches its area: `frontend-design`, `gate-adapter`, `browser-agent`, `human-in-the-loop`, `testing`, `review`.
