# Project notes

Where Gatecrusher stands, what is paused and why, and the plan from here. Updated
2026-10-05. The slice plan the first three slices were built against is in
[SLICES.md](SLICES.md); it is kept as a record, not as the current plan.

## What has been done

**Slice 1 — scaffold.** pnpm + Turborepo monorepo (`apps/web`, `apps/worker`,
`packages/core`, `packages/db`, `packages/gates`), Postgres + Redis via Docker Compose,
Drizzle schema and migrations, env validation, dark UI shell with nav, `/api/health`
with a worker-offline banner, GitHub Actions CI.

**Slice 2 — ingest + classify.** Paste a playlist URL; tracks are read through
SoundCloud's api-v2 (with a `yt-dlp -J` fallback for metadata), stored idempotently, and
classified `native` / `gate` / `buy` / `none` by a table-tested classifier. Tracks table
with sort and filter; buy list with CSV export. No browser involved.

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
   (CSV export) for the owner to complete by hand.

## Later

- How to approach gates without an automated browser, and whether an AI agent still
  has a place. Nothing is scheduled.
- The slice 4–6 plans in SLICES.md (pause/resume, agent, evals) assume the browser and
  are on hold with it.

## Left out, and why

- **Ripping streams of tracks that are not downloadable.** Asked for on 2026-10-05
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
