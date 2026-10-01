---
name: gate-adapter
description: How to write a new GateAdapter end to end in packages/gates - detection, resumable steps, human-like delays, blocker detection after every step, needs_human handling, results, fixtures (including a captcha fixture), tests, and registry registration. Use when adding or changing any download-gate adapter (Hypeddit, ToneDen, native SoundCloud, etc.).
---

# Writing a gate adapter

## When to use

Adding support for a new gate platform, or changing an existing adapter in `packages/gates`. For the pause/resume mechanics themselves see the `human-in-the-loop` skill; for the AI fallback see `browser-agent`.

## Non-negotiables

- Never attempt a captcha or anti-bot check. Detect, hand over.
- Never fail on a captcha, email confirmation, login challenge, or unexpected page — return `needs_human`.
- Never click purchase/checkout controls.
- Return result types; do not throw for expected outcomes.
- All waits between actions go through `ctx.delay()`; no bare `waitForTimeout`, no zero-delay action chains.

## The contract (defined in `packages/core`)

```ts
interface GateAdapter {
  id: string;                       // "hypeddit"
  priority: number;                 // higher runs first; AI agent is lowest
  detect(url: URL): boolean;        // pure, no network
  steps: readonly GateStep[];       // ordered, each resumable
}

interface GateStep {
  name: string;                     // stable identifier, stored in DB — never rename casually
  run(ctx: GateContext): Promise<StepResult>;
}

type StepResult =
  | { kind: "next" }                                       // go to following step
  | { kind: "done"; download: DownloadedFile }             // adapter finished
  | { kind: "needs_human"; reason: HumanReason; description: string }
  | { kind: "impossible"; reason: ManualReason; detail: string };  // -> MANUAL

type HumanReason = "captcha" | "email_confirmation" | "login_challenge" | "unexpected_page" | "agent_request";
type ManualReason = "dead_link" | "file_gone" | "account_required" | "user_gave_up";
```

`GateContext` gives the adapter: `page`, `track`, `gateUrl`, `delay(kind)`, `screenshot(label)`, `emit(event)`, `checkBlockers()`, `waitForDownload(trigger)`, `state` (small JSON bag persisted between steps), and `log` (pino child). Adapters do not touch the DB, the queue, or the filesystem directly.

The **step runner** (shared, in `packages/gates/src/runner`) owns the loop: emit `step_started`, run the step, run `checkBlockers()`, persist the step index + `state`, emit `step_finished`. Adapters only supply steps.

## Procedure

### 1. Detection

- `detect(url)` matches on hostname (and path shape if needed). Pure and synchronous. Cover redirectors/short links the platform uses.
- Add table-driven unit tests: positives, near-miss negatives, uppercase hosts, `www.` and subdomains, query strings.

### 2. Write steps so they are resumable

Each step must be **safe to re-enter**: the runner may call it again after a pause, or after a worker restart on a freshly loaded page.

- Start every step by checking whether its goal is already satisfied ("already following", "download button already unlocked") and return `next` if so.
- One user-visible action per step: `open-gate`, `connect-soundcloud`, `follow-artist`, `like-track`, `repost`, `unlock`, `download`. Small steps make pause points precise.
- Put anything a later step needs into `ctx.state` (serialisable), not closures or module variables.
- Step 0 is always `open-gate`: navigate to `ctx.gateUrl` and classify dead links (HTTP 404/410, platform's "this gate no longer exists" page) as `impossible: dead_link`.

### 3. Locators

- Prefer `getByRole` / `getByText` / `getByLabel`; fall back to stable attributes. No nth-child chains or generated class names.
- Keep all locators for an adapter in one `locators.ts` so a site redesign is a one-file fix.
- Popups (SoundCloud OAuth connect windows): `context.waitForEvent("page")` around the click, then run `checkBlockers()` on the popup too.
- Use Playwright's auto-waiting with explicit timeouts. A timeout on an expected element is **not** a failure — it is `needs_human: unexpected_page`.

### 4. Delays

`await ctx.delay("action")` before each click/type, `ctx.delay("read")` after a navigation, `ctx.delay("between-steps")` is applied by the runner. Ranges are configured centrally (randomised, not fixed). Type with per-key delay via the ctx helper. In tests the delay provider is replaced with a zero-delay fake.

### 5. Blocker detection after every step

The runner calls `ctx.checkBlockers()` after each step; call it yourself after any navigation or popup inside a step. The shared detector looks for:

- **Captcha / anti-bot:** iframes or scripts from recaptcha, hcaptcha, turnstile/challenges.cloudflare.com, DataDome, PerimeterX, Arkose; "verify you are human"-style interstitials.
- **Login challenge:** SoundCloud sign-in form, "confirm it's you", 2FA prompts.
- **Email confirmation:** "check your inbox", "enter the code we sent".
- **Unexpected page:** URL host outside the adapter's allowed set, or none of the step's expected landmarks present.

Add platform-specific signals to the adapter's `blockers.ts` when the shared detector isn't enough. Detection only reads the DOM — it never interacts with the challenge.

### 6. needs_human

Return `{ kind: "needs_human", reason, description }`. The description is an instruction to the user in one sentence: "Solve the captcha in the Hypeddit tab, then click Continue." The runner takes the screenshot, emits the event, and parks the job. When resumed, the runner calls **the same step again** — which is why step 2's "already satisfied?" check matters.

If the human has done more than asked (e.g. completed the next two steps), later steps skip themselves via the same check.

### 7. Download and result

- Final step uses `ctx.waitForDownload(() => locator.click())`. The ctx saves it to the downloads layout and runs verification (exists, above `MIN_DOWNLOAD_BYTES`, and sniffed from bytes as audio or as a zip containing an audio entry above the threshold).
- Verification failure is not success: HTML error page saved as `.mp3` -> `impossible: file_gone` if the platform says so, otherwise `needs_human: unexpected_page`.
- Return `{ kind: "done", download }`.
- Use `impossible` only for the four `ManualReason`s, always with `detail` a human can act on.

### 8. Fixtures

Under `packages/gates/src/<adapter>/__fixtures__/`, static HTML served by the test fixture server:

- `happy/` — one page per step state, wired with minimal inline JS so clicking advances it; final page links to a small real audio file (> 1 MB generated in test setup, not committed).
- `captcha.html` — the gate page with a captcha iframe (`<iframe src="/fake/recaptcha/anchor">`) appearing at a chosen step.
- `captcha-cleared.html` or a toggle endpoint — the same page after the human "solved" it, to test resume.
- `dead-link.html`, `file-gone.html`, `login-challenge.html`, `unexpected.html`.

Fixtures are hand-written minimal reproductions of the structure the locators rely on — do not paste full saved pages (size, third-party scripts, personal data). Note the capture date in a comment.

### 9. Tests (Vitest + Playwright library, headless, offline)

Required cases per adapter:

- [ ] `detect` table tests
- [ ] happy path -> `done`, file verified
- [ ] captcha appears at step N -> `needs_human: captcha`, job parked at step N, screenshot emitted
- [ ] resume after captcha cleared -> continues from step N, earlier steps not re-executed (assert click counts)
- [ ] resume while captcha still present -> `needs_human` again, no step advance
- [ ] resume on a fresh page (simulated worker restart) -> steps self-skip to the right place
- [ ] dead link -> `impossible: dead_link`
- [ ] login challenge and unexpected page -> `needs_human`
- [ ] bad download (tiny / wrong MIME / zip with no audio) -> not `done`
- [ ] zip containing audio -> `done`, recorded as an archive
- [ ] no test makes a request to a non-localhost host (enforced by the fixture server's route guard)

### 10. Register

Add the adapter to `packages/gates/src/registry.ts` with its priority. The registry test asserts: unique ids, unique step names within an adapter, the AI agent has the lowest priority, and each known sample URL resolves to the expected adapter.

## Done when

All test cases above pass, `pnpm lint && pnpm typecheck && pnpm test` is green, and the `review` skill has been run.
