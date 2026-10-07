---
name: review
description: Gatecrusher self-review checklist to run before finishing any slice - hard rules, types, error handling, security, secrets, logging, UX states, pause/resume paths, and tests. Use after the checks pass and before summarising a slice, or whenever asked to review project changes.
---

# Slice self-review

## When to use

After building a slice and getting `pnpm lint && pnpm typecheck && pnpm test` green, before writing the final summary. Also on request ("review this").

## How to run it

1. List every file created or changed in the slice.
2. Read each changed file in full — do not review from memory of what you wrote.
3. Walk the checklist. For each item answer **pass**, **fail** (with `file:line`), or **n/a**.
4. Fix every fail, then re-run `pnpm lint && pnpm typecheck && pnpm test`.
5. Report: what was checked, what was found and fixed, anything deliberately left open and why. Do not report a clean review without having done step 2.

## Checklist

### Hard rules (any failure blocks the slice)

- [ ] No code attempts, solves, or interacts with a captcha or anti-bot check; no stealth/evasion libraries or flags
- [ ] No path where a captcha, email confirmation, login challenge, or unexpected page ends in `FAILED` or `MANUAL` — they all become `needs_human`
- [ ] `MANUAL` is only reachable via `dead_link`, `file_gone`, `account_required`, `user_gave_up`, and always stores reason + link
- [ ] Nothing clicks purchase/checkout controls; buy links are only ever shown as the HQ Download link
- [ ] SoundCloud login is only the pasted `oauth_token` (hard rule 5): no password is asked for, stored or typed; the token leaves `soundcloud_account` only for yt-dlp's temporary cookie file (deleted after the job), and never reaches a log, an error message, an API response, the UI or a command line
- [ ] Worker browser is headed, persistent profile, concurrency 1, all actions go through the randomised delay helper

### Types

- [ ] No `any`, no `as` casts that bypass validation, no unexplained `!`
- [ ] Types at boundaries are inferred from zod schemas (`z.infer`), not duplicated by hand
- [ ] Discriminated unions are handled exhaustively (`never` check in switches)
- [ ] Shared types live in `packages/core`; no cross-app imports; `gates` does not import `db`

### Error handling

- [ ] Adapters and steps return result types; no `throw` for expected outcomes
- [ ] Every `await` on Playwright/network/DB has a defined outcome on failure (result, retry, or caught at the job boundary)
- [ ] Timeouts are explicit; a timeout waiting for an expected element becomes `needs_human: unexpected_page`
- [ ] No swallowed errors (`catch {}`), no floating promises
- [ ] API routes return typed error bodies with correct status codes

### Security

- [ ] All external input validated with zod: request bodies, params, queue payloads, SoundCloud/yt-dlp responses, AI tool inputs
- [ ] Playlist and gate URLs are restricted to http(s); no server-side fetch of user-supplied URLs to private/localhost addresses
- [ ] File paths are built from sanitised names and confined to the data directory (no traversal from track titles); screenshot-serving route cannot read arbitrary files
- [ ] Child processes (yt-dlp) use argument arrays, never shell strings
- [ ] Page content is treated as untrusted in the browser agent (guardrails in code, not only in the prompt)
- [ ] No raw SQL string building; Drizzle query builder or parameterised SQL only
- [ ] The web app is not exposed beyond what is intended (bind address, any auth decided for the slice)

### Secrets

- [ ] No credentials, API keys, cookies, `client_id`s, or tokens in code, fixtures, tests, logs, events, or screenshots taken on purpose of login forms
- [ ] `.env*` (except `.env.example`), the browser profile, downloads, and screenshots are gitignored
- [ ] `.env.example` is updated for every new variable, with placeholder values
- [ ] Env is validated at startup; missing values produce a clear message that names the variable but not its value

### Logging and events

- [ ] pino everywhere; no `console.log` left behind
- [ ] Logs are structured objects with `jobId` / `trackId` / `runId` / `adapterId` / `step` where relevant
- [ ] Redaction paths cover the sensitive keys; nothing logs full page HTML or request headers
- [ ] Every job state change and every step writes an event; events validate against their zod schema
- [ ] Agent actions log screenshot path, token counts, and cost

### UX states (if the slice touched UI)

- [ ] Empty, loading, error, populated states exist for each data view
- [ ] SSE disconnect and worker-offline are handled visibly
- [ ] Needs-you is visible in nav counter, run page, and table row
- [ ] Destructive actions confirm; buttons show pending state; no double-submit
- [ ] Works at 375 / 768 / 1280px; keyboard and focus OK
- [ ] The `frontend-design` component checklist passes

### Pause / resume (if the slice touched worker, queue, adapters, or agent)

- [ ] Every step is safe to re-enter and checks "already satisfied" first
- [ ] Step index and adapter state are persisted in the same transaction as the status change
- [ ] A parked job frees the queue slot; the parked tab is never touched by the worker
- [ ] Continue: blocker cleared, blocker still present, and page-lost paths all handled
- [ ] Give up: marks `MANUAL` with reason + link and releases the tab
- [ ] Worker restart reconciliation covers `RUNNING` and `WAITING_FOR_HUMAN`
- [ ] Continue and Give up are idempotent

### Downloads

- [ ] Success is only recorded after verification: exists, above `MIN_DOWNLOAD_BYTES`, sniffed from bytes as audio or a zip containing audio
- [ ] Zip handling reads entry metadata only and never extracts to a path taken from the archive
- [ ] Partial/failed files are cleaned up; filenames are sanitised and collisions handled
- [ ] Re-running a playlist does not re-download verified tracks

### Tests

- [ ] New behaviour has tests at the right layer (see `testing`)
- [ ] Adapters have the full fixture set including captcha pause + resume
- [ ] No `.only`, no skipped tests, no network access, no real delays
- [ ] `pnpm lint && pnpm typecheck && pnpm test` passes — paste the result

### Scope and hygiene

- [ ] Only what the slice's acceptance criteria call for was built
- [ ] No dependency added without asking
- [ ] No dead code, TODOs without context, or commented-out blocks
- [ ] Docs updated if behaviour or architecture changed (`docs/ARCHITECTURE.md`, `docs/SLICES.md`, `CLAUDE.md`)
- [ ] No commits or branches were created
