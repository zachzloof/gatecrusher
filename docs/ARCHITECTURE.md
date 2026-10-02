# Architecture

Gatecrusher is a pnpm + Turborepo monorepo. The web app and its API run in Docker alongside Postgres and Redis; the worker runs natively on the host so its headed browser window is visible to the user.

## System overview

```mermaid
flowchart LR
    user([User])

    subgraph docker[Docker Compose]
        subgraph web[apps/web - Next.js]
            ui[UI<br/>App Router, Tailwind, shadcn/ui]
            api[API route handlers<br/>zod-validated]
            sse[SSE endpoint<br/>/api/runs/:id/events]
        end
        pg[(Postgres<br/>playlists, tracks, runs, jobs,<br/>events, downloads, human_requests)]
        redis[(Redis<br/>BullMQ queue + pub/sub)]
    end

    subgraph host[Host machine - native]
        subgraph worker[apps/worker - Node]
            proc[BullMQ processor<br/>concurrency 1, random delays]
            runner[Step runner<br/>checkpoint after every step]
            parked[Parked-page registry<br/>tabs left open for the human]
        end
        subgraph gates[packages/gates]
            registry[Adapter registry<br/>by priority]
            native[Native SoundCloud adapter]
            hyp[Hypeddit adapter]
            other[Other gate adapters]
            agent[AI browser agent<br/>lowest priority]
        end
        browser[[Headed Chromium<br/>persistent burner profile]]
        fs[/Filesystem<br/>downloads, screenshots/]
    end

    sc[(SoundCloud api-v2<br/>yt-dlp -J fallback)]
    anthropic[(Anthropic API)]
    sites[(SoundCloud and gate sites)]

    user -->|paste playlist URL, start run| ui
    ui --> api
    api -->|ingest + classify| sc
    api -->|read / write| pg
    api -->|enqueue track jobs| redis
    redis -->|job| proc
    proc --> runner
    runner --> registry
    registry --> native & hyp & other & agent
    native & hyp & other & agent -->|Playwright| browser
    browser --> sites
    agent -->|tool-use loop| anthropic
    browser -->|verified download| fs
    runner -->|screenshots| fs
    runner -->|events, status, checkpoints| pg
    runner -->|publish event| redis
    redis -->|pub/sub| sse
    sse -->|live status| ui

    %% needs_human loop
    runner -. needs_human: park page, free the slot .-> parked
    ui -. Needs you card: screenshot + instruction .-> user
    user -. acts in the real browser window .-> browser
    user -. Continue / Give up .-> ui
    api -. resume or release job, high priority .-> redis
    parked -. same page, same step .-> runner
```

## The needs_human loop

```mermaid
sequenceDiagram
    actor U as User
    participant UI as Web UI
    participant API as API routes
    participant Q as Redis / BullMQ
    participant W as Worker
    participant B as Browser tab
    participant DB as Postgres

    W->>B: run step N
    W->>B: checkBlockers()
    B-->>W: captcha iframe present
    W->>DB: tx: checkpoint step N, human_request OPEN,<br/>job WAITING_FOR_HUMAN, needs_human event
    W->>Q: publish event
    Note over W,B: page parked, left open.<br/>Processor returns - queue slot is free.
    Q-->>UI: SSE needs_human
    UI-->>U: Needs you card (screenshot, instruction)
    W->>B: next track runs in a new tab
    U->>B: solves captcha in the real window
    U->>UI: Continue
    UI->>API: POST /human-requests/:id/continue
    API->>DB: request CONTINUED, job QUEUED
    API->>Q: enqueue resume (high priority)
    Q->>W: resume job
    W->>B: checkBlockers() on the parked page
    alt blocker cleared
        W->>B: re-enter step N, continue to the end
        W->>DB: verified download, job SUCCEEDED
    else still blocked
        W->>DB: new human_request (attempt+1), stay WAITING_FOR_HUMAN
    else page lost (restart / tab closed)
        W->>B: new tab, steps self-skip from step 0
    end
```

Details, timeouts and restart behaviour: `.claude/skills/human-in-the-loop/SKILL.md`.

## Packages and responsibilities

| Package | Owns | Must not |
| --- | --- | --- |
| `apps/web` | UI, API route handlers, SSE, CSV export, enqueueing | Drive a browser; contain gate logic |
| `apps/worker` | BullMQ processors, browser lifecycle, step runner wiring, parked pages, download storage, startup reconciliation | Serve HTTP to the UI |
| `packages/db` | Drizzle schema, migrations, repository functions | Contain business rules |
| `packages/core` | Types, zod schemas, classifier, `GateAdapter` interfaces, result types, job state machine | Import any other workspace package or do I/O |
| `packages/gates` | Adapters, blocker detection, step runner, AI agent | Import `db` or the queue — it reports via `GateContext` |

## Data model (outline)

- **playlists** — canonical SoundCloud URL (the re-ingest key), title, owner, ingest source (`api_v2` | `yt_dlp`), last ingested.
- **tracks** — SoundCloud id, title, artist, permalink, `purchase_url`, `purchase_title`, `downloadable`, classification (`native` | `gate` | `buy` | `none`), detected gate platform.
- **runs** — one execution of a playlist; aggregate counts and status.
- **jobs** — one per track per run: status, adapter id, `step_index`, adapter `state` (JSON), attempts, manual reason + link.
- **events** — append-only log per job: type, step, screenshot path, error, payload (JSON, zod-validated per type).
- **downloads** — file path, size, MIME, kind (`audio` | `archive`), checksum, verified-at; unique per track.
- **human_requests** — reason, description, screenshot, page URL, status, attempt, session-alive flag, resolution.

Postgres is the source of truth. Redis carries jobs and change notifications only; the UI can always rebuild its view from Postgres.

## Job lifecycle

```mermaid
stateDiagram-v2
    [*] --> QUEUED
    QUEUED --> RUNNING
    RUNNING --> SUCCEEDED: download verified
    RUNNING --> WAITING_FOR_HUMAN: captcha, email confirm,<br/>login challenge, unexpected page
    WAITING_FOR_HUMAN --> QUEUED: Continue
    WAITING_FOR_HUMAN --> MANUAL: Give up
    RUNNING --> MANUAL: dead link, file gone,<br/>account required
    RUNNING --> FAILED: crash / infrastructure
    FAILED --> QUEUED: Retry
    SUCCEEDED --> [*]
    MANUAL --> [*]
```

`buy` and `none` tracks never get a browser job; they go straight to the buy list or are shown as having no download.

## Adapter selection

1. The classifier (pure, in `core`) labels the track from SoundCloud metadata.
2. `native` -> native SoundCloud adapter. `gate` -> the registry returns the highest-priority adapter whose `detect(url)` matches.
3. If no specific adapter matches, the AI browser agent (lowest priority, matches anything) takes it.
4. All adapters run through the same step runner, emit the same events, and pause/resume the same way.

## Filesystem layout (host, configurable via env)

```
data/
  browser-profile/              persistent Chromium profile (burner login) - never committed
  downloads/<playlist-slug>/<artist> - <title>.<ext>
  screenshots/<run-id>/<job-id>/<seq>-<label>.png
```

The web container mounts `data/screenshots` read-only to serve images to the UI through a route that only resolves paths recorded in the database.

A download is written under a temporary name (`.partial-<uuid>`) and only renamed into place once it has passed verification; a failed one is deleted. A second file wanting the same name becomes `<artist> - <title> (2).<ext>`.

## Deployment shape

- **Development:** `docker compose up` -> Postgres and Redis only. Web runs natively with `pnpm dev` (fast reload, direct access to `data/`).
- **Production:** `docker compose --profile web up` -> Postgres, Redis, and the built web image, with `data/screenshots` mounted read-only.
- `pnpm --filter @gatecrusher/worker start` on the host -> worker + visible browser, connecting to the Compose-published Postgres and Redis ports on localhost.
- Everything is expected to run on one machine the user controls. The web UI is intended for local/LAN use.
