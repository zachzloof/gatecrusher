---
name: testing
description: Testing strategy for Gatecrusher - unit, integration and e2e layers, offline gate fixtures, how to run each suite, and the definition of a done slice. Use when writing or changing tests, adding fixtures, setting up test infrastructure, or deciding whether a slice is finished.
---

# Testing

## When to use

Writing tests, adding fixtures, wiring test tooling or CI, or checking a slice against "done".

## Principles

- **Offline by default.** `pnpm test` never touches SoundCloud, gate sites, or the Anthropic API. External HTTP is faked at the boundary; browser tests run against local fixture pages.
- **Test behaviour at boundaries**, not implementation details: classifier in -> classification out; adapter + fixture -> result + events.
- **The pause/resume path is a first-class test target**, not an edge case.
- Tests are deterministic: fake delays, fake clock where time matters, no `sleep`.

## Layers

### Unit — Vitest, colocated `*.test.ts`

Pure logic in `packages/core` and helpers elsewhere:

- gate classifier (table-driven over `purchase_url`, `purchase_title`, `downloadable` combinations — keep a growing `cases.ts` of real-world examples),
- adapter `detect` functions,
- job state `transition()`,
- zod schemas (accept/reject samples),
- download verifier (tiny file, HTML-as-mp3, valid audio header, zip with audio, zip without audio, custom threshold),
- delay provider (ranges, never zero in production config),
- CSV export, env validation, cost calculation.

### Integration — Vitest, `*.int.test.ts`

Real pieces wired together, still offline:

- **Adapters against fixtures:** Playwright library (headless Chromium) + a local fixture server. The server's route guard aborts and fails the test on any non-localhost request. See `gate-adapter` for the required case list, including the captcha-iframe fixture and resume.
- **Browser agent:** scripted fake Anthropic client + fixtures. See `browser-agent`.
- **Queue + pause/resume:** real BullMQ against Redis, real Postgres, fake adapter that returns `needs_human` on demand. See `human-in-the-loop` for the case list.
- **DB:** migrations apply cleanly to an empty database; repository functions against real Postgres (no mocking Drizzle).
- **API route handlers:** call handlers with real DB; assert zod-validated responses and error shapes.
- **SoundCloud ingest:** recorded JSON responses (sanitised, committed under `__fixtures__`) served by a fake fetch; includes the `client_id`-expired path and the yt-dlp fallback (fake process runner with recorded `-J` output).

Postgres and Redis for integration tests come from Docker Compose (`docker compose up -d`, which starts only those two), using a separate test database that is migrated in global setup and truncated between test files.

### E2E — Playwright Test, `apps/web/e2e`

The UI against a running web app with a seeded database and a **fake worker** (a script that writes events/states), so e2e does not need a real browser-automation run:

- paste URL -> tracks table and buy list render; CSV export downloads
- run page shows live status changes over SSE
- Needs-you card appears with screenshot; Continue and Give up work
- retry on a failed job
- empty / loading / error states for each main view
- one mobile-viewport pass (375px) on the main pages

Headless is fine here. The "no headless" hard rule applies to the worker's real gate browser, not to tests.

### Manual smoke — not automated, documented per slice

Anything involving the live sites and the burner account (login script, a real native download, a real gate). Each slice summary lists the exact manual steps. Never automate these in CI.

## Fixtures

- Location: `__fixtures__/` next to the code that uses them.
- Hand-written minimal HTML reproducing only the structure the locators rely on. No saved full pages, no third-party script tags that load, no personal data, no real tokens or `client_id`s.
- Always include, per gate adapter: happy path, **captcha iframe**, captcha cleared, dead link, file gone, login challenge, unexpected page.
- Audio test files are generated in test setup (valid header + padding to > 1 MB), not committed.
- Each fixture has a top comment: what it reproduces and the date it was modelled.

## How to run

```sh
pnpm lint                 # eslint across the workspace
pnpm typecheck            # tsc --noEmit across the workspace
pnpm test                 # unit + integration (needs postgres + redis up)
pnpm test:unit            # unit only, no services needed
pnpm test:e2e             # Playwright UI e2e
pnpm --filter @gatecrusher/gates test    # one package
pnpm vitest run path/to/file.test.ts     # one file
```

CI runs lint, typecheck, unit, integration (service containers), and e2e headless. CI never runs the headed worker or anything against live sites.

## What a "done" slice looks like

- [ ] Every acceptance criterion in `docs/SLICES.md` for the slice is met and demonstrably covered by a test or a listed manual step
- [ ] New logic has unit tests; new boundaries have integration tests; new UI has e2e coverage
- [ ] Any new adapter has the full fixture set, including captcha pause and resume
- [ ] `pnpm lint && pnpm typecheck && pnpm test` passes locally, output shown
- [ ] `pnpm test:e2e` passes if the slice touched the UI
- [ ] No skipped or `.only` tests; no test hitting the network
- [ ] The `review` skill has been run and its findings addressed
- [ ] Summary written: commands to run, things to click, manual smoke steps, known gaps
