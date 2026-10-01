---
name: human-in-the-loop
description: How pause/resume works across worker, queue and UI - the needs_human event schema, WAITING_FOR_HUMAN state, how the worker keeps the page open without blocking the queue, how Continue and Give up reach the worker, timeouts, and worker-restart recovery. Use when touching job state transitions, the step runner, parked pages, the human_requests table, resume/give-up API routes, or the Needs-you UI wiring.
---

# Human-in-the-loop: pause and resume

## When to use

Any change to: job states, the step runner, the parked-page registry, `human_requests`, the Continue / Give up routes, SSE events for paused jobs, or timeouts. UI presentation is in `frontend-design`; adapter-side detection is in `gate-adapter`.

## The guarantee

A captcha, email confirmation, login challenge, or unexpected page **never fails a job**. The job parks, the browser page stays open on that page, the queue keeps moving, and Continue resumes from the same step.

## Job states

```
QUEUED -> RUNNING -> SUCCEEDED
                  -> WAITING_FOR_HUMAN -> (Continue) QUEUED(resume) -> RUNNING ...
                                       -> (Give up)  MANUAL
                  -> MANUAL            (impossible: dead_link | file_gone | account_required)
                  -> FAILED            (crash / infrastructure; retryable via Retry button)
```

Transitions are enforced by one function in `packages/core` (`transition(from, event) -> Result`), unit-tested exhaustively. Nothing writes a job status except through it.

## needs_human event schema (zod, in `packages/core`)

```ts
const NeedsHumanEvent = z.object({
  type: z.literal("needs_human"),
  jobId: z.string().uuid(),
  trackId: z.string().uuid(),
  runId: z.string().uuid(),
  humanRequestId: z.string().uuid(),
  adapterId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  stepName: z.string(),
  reason: z.enum(["captcha", "email_confirmation", "login_challenge", "unexpected_page", "agent_request"]),
  description: z.string().min(1).max(280),   // instruction to the user
  screenshotPath: z.string(),                // relative to the data dir
  pageUrl: z.string().url(),
  sessionAlive: z.boolean(),                 // false once the page was lost
  createdAt: z.string().datetime(),
});
```

The `human_requests` row mirrors this plus `status` (`OPEN` | `CONTINUED` | `GAVE_UP` | `SUPERSEDED`), `resolvedAt`, `giveUpReason`, and `attempt`.

## How parking works without blocking the queue

Concurrency is 1 and must stay 1, so a paused job cannot sit inside the BullMQ processor waiting. Instead:

1. A step returns `needs_human`. The runner takes a screenshot, then in **one DB transaction**: persists `stepIndex` + adapter `state`, inserts the `human_requests` row, sets the job to `WAITING_FOR_HUMAN`, inserts the event. Then publishes the event on Redis pub/sub.
2. The runner hands the Playwright `Page` to the **parked-page registry** (in-memory `Map<jobId, Page>` in the worker). The page — its own tab in the persistent context — is left open and untouched.
3. The BullMQ processor **returns normally** with outcome `parked`. The slot is free; the next job opens a new tab.

Rules for the registry:

- The worker never navigates, reloads, focuses, or closes a parked tab. The human owns it.
- Cap parked tabs (`MAX_PARKED_PAGES`, default 5). At the cap, the queue is paused for gate jobs and the UI says "Resolve a paused track to continue the run". Native-download jobs still run.
- "One active automation at a time" still holds: parked tabs are idle.
- When a new `needs_human` is raised, bring that tab to front once (`page.bringToFront()`); never steal focus afterwards.

## How Continue and Give up reach the worker

Web and worker share only Postgres and Redis.

- **Continue:** `POST /api/human-requests/:id/continue` -> validate -> in a transaction mark the request `CONTINUED` and the job `QUEUED` -> enqueue a BullMQ `resume` job `{ jobId, humanRequestId }` with **higher priority** than fresh jobs (so a human's action is honoured next, after the currently running job finishes). Idempotent: a second click on a non-`OPEN` request is a no-op returning the current state.
- **Give up:** `POST /api/human-requests/:id/give-up` with optional reason -> job `MANUAL` (`user_gave_up`, with the gate link) -> enqueue a small `release` job so the worker closes the parked tab.
- **Resume processing in the worker:**
  1. Look up the page in the registry.
  2. **Page alive:** run `checkBlockers()`. Still blocked -> new screenshot, new `human_requests` row (`attempt + 1`, old one `SUPERSEDED`), park again. Clear -> call the **same step** again from the persisted `stepIndex` with persisted `state`.
  3. **Page missing** (restart, user closed the tab): open a new tab, navigate to the gate URL, and run from step 0 — steps self-skip when already satisfied (see `gate-adapter`). If a blocker reappears, park again.

The user never needs to tell the system *what* they did; Continue just means "look again".

## Live updates to the UI

Worker publishes every event to a Redis channel per run; `GET /api/runs/:id/events` (SSE) subscribes and streams. On connect, the route first replays current state from Postgres, then streams — so a reconnect or refresh is always consistent. Postgres is the source of truth; pub/sub is only a nudge.

## Timeouts

- A human request **never auto-fails and never auto-becomes manual**.
- After `HUMAN_REQUEST_TAB_TTL` (default 12h) the worker closes the parked tab to free resources, sets `sessionAlive=false`, and emits an update. The job stays `WAITING_FOR_HUMAN`; Continue takes the "page missing" path.
- Reminder notification after a configurable interval (slice 6).
- A run is "finished" when no job is `QUEUED`/`RUNNING`; it is "finished, waiting on you" while any are `WAITING_FOR_HUMAN`.

## Worker restart

On startup the worker reconciles before taking jobs:

- Jobs `RUNNING` in DB (it died mid-step) -> back to `QUEUED` at their persisted `stepIndex`, event `recovered_after_restart`.
- Jobs `WAITING_FOR_HUMAN` -> stay as they are; their open requests get `sessionAlive=false` (the registry is empty after a restart) and an update event so the card shows "Reopen and retry step".
- BullMQ stalled-job handling is configured so a job is never double-processed; the processor is idempotent on `(jobId, stepIndex)`.
- Graceful shutdown (SIGINT/SIGTERM): stop taking jobs, let the current step finish or checkpoint, mark sessions lost, close the browser context cleanly so the profile is not corrupted.

## Tests required when touching this area

- [ ] `transition()` table test: every state x event, illegal transitions rejected
- [ ] step returns `needs_human` -> processor returns, next queued job starts while the first is parked
- [ ] Continue with blocker cleared -> same step re-entered, earlier steps not re-run
- [ ] Continue with blocker still present -> parked again, attempt incremented, no state advance
- [ ] Continue after simulated restart (registry empty) -> page-missing path
- [ ] Give up -> `MANUAL` with reason + link, tab closed
- [ ] double Continue is idempotent
- [ ] parked-page cap pauses gate jobs only
- [ ] TTL expiry closes the tab and keeps the job `WAITING_FOR_HUMAN`
- [ ] startup reconciliation for `RUNNING` and `WAITING_FOR_HUMAN` jobs
- [ ] SSE: connect mid-run replays state, then streams
- [ ] UI e2e: Needs-you card appears with screenshot, Continue and Give up work
