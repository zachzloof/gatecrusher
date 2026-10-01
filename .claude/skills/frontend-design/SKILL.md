---
name: frontend-design
description: Design system and UI rules for the Gatecrusher web app (dark, restrained, DJ-tool feel). Use when creating or changing any page, component, table, status display, or the "Needs you" pattern in apps/web.
---

# Frontend design

## When to use

Any work in `apps/web` that renders something: new pages, components, tables, states, colours, copy. Read this before writing JSX, and run the component checklist at the bottom before calling UI work done.

## Direction

A tool a DJ leaves open on a second monitor while digging. Think hardware and DAW panels (CDJ screen, Ableton's session view), not a SaaS dashboard: dense, calm, legible at a glance, one loud colour reserved for "this needs you".

**Avoid the template look:** no gradient hero, no glassmorphism, no purple-to-blue gradients, no card grid of stat tiles with icons, no rounded-2xl-everything, no emoji as icons, no default shadcn zinc theme left untouched.

## Design tokens

Define as CSS variables in `apps/web/app/globals.css`, map them into the Tailwind theme, and override shadcn's variables with them. Components use tokens only — no raw hex, no arbitrary Tailwind colour values.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0b0c0e` | page |
| `--surface-1` | `#131518` | panels, table |
| `--surface-2` | `#1b1e22` | row hover, inputs |
| `--border` | `#262a30` | hairlines (1px, never heavier) |
| `--text` | `#e7e9ec` | primary |
| `--text-muted` | `#8b929b` | secondary, metadata |
| `--text-faint` | `#5b626b` | disabled, placeholders |
| `--accent` | `#ff7a1a` | **Needs you** and the single primary action only |
| `--ok` | `#3ecf8e` | downloaded / verified |
| `--info` | `#5aa9ff` | running / in progress |
| `--warn` | `#f2c94c` | buy list, retryable |
| `--danger` | `#f0524f` | failed, destructive |
| `--manual` | `#a78bfa` | manual list |

Rules: the accent appears at most once per viewport outside "Needs you" cards. Status is never colour alone — always pair with a label or icon. Check contrast: body text ≥ 4.5:1 against its surface.

## Typography

- **UI:** Inter (via `next/font`), 14px base, 20px line height.
- **Data:** JetBrains Mono for durations, file sizes, counts, step names, URLs, timestamps. Use `tabular-nums` in every numeric column.
- Scale: 12 / 13 / 14 / 16 / 20 / 28. Only the page title uses 20+. Weights 400 and 500; 600 only for the page title.
- Section labels: 11–12px, uppercase, `letter-spacing: 0.06em`, `--text-muted`.

## Spacing, shape, motion

- 4px grid. Table rows 36px (compact) — density is a feature. Page gutters 24px desktop, 16px mobile.
- Radius: 6px controls, 8px panels. Nothing larger.
- Borders over shadows. Shadows only on overlays (dialog, popover).
- Motion: 120–160ms ease-out on hover/focus/expand. The only looping animation allowed is the running-status indicator and the "Needs you" pulse. Respect `prefers-reduced-motion`.

## Layout

- Left nav rail (collapses to icons < 1024px, bottom bar < 640px): Playlists, Runs, Buy list, Manual list, Evals, Settings.
- A persistent **Needs you** counter in the nav, in accent, visible from every page when > 0.
- Content max-width 1400px; tables use the full width.

## Status vocabulary

One `StatusBadge` component, one mapping, used everywhere:

| Status | Label | Colour |
| --- | --- | --- |
| `QUEUED` | Queued | muted |
| `RUNNING` | Running · *step name* | info |
| `WAITING_FOR_HUMAN` | Needs you | accent |
| `SUCCEEDED` | Downloaded | ok |
| `BUY` | Buy | warn |
| `MANUAL` | Manual | manual |
| `FAILED` | Failed · retry | danger |
| `NONE` | No download | faint |

## The "Needs you" pattern

This is the most important UI in the product. It must be impossible to miss and quick to act on.

- **Where:** pinned section at the top of the run page, above the track table; also a global `/needs-you` view and the nav counter. The track's table row shows the accent badge and scrolls to the card on click.
- **Card contents, in order:**
  1. Track artist — title, gate platform, how long it has been waiting.
  2. The **description of what is needed**, as an instruction: "Solve the captcha in the browser window, then click Continue."
  3. The screenshot (click to enlarge), so the user can find the right tab.
  4. Step indicator: "Step 4 of 7 · follow-artist".
  5. Actions: **Continue** (primary, accent), **Give up** (ghost, danger text, confirm dialog that requires a reason or uses a default), and "Bring window to front" if supported.
- **Behaviour:** Continue shows a pending state until the worker acknowledges; if the worker reports the blocker is still there, the card stays with an updated screenshot and a plain message ("Captcha still showing"). Never an error toast for this.
- **Session lost** (worker restarted): the card says so and Continue becomes "Reopen and retry step".
- Card border-left 2px accent; a slow pulse on the badge only, not the whole card.
- New `needs_human` arriving updates the document title: `(2) Needs you — Gatecrusher`.

## States — every data view needs all four

- **Empty:** one sentence saying what goes here and the single action to fill it. No illustrations.
- **Loading:** skeleton rows matching the final layout; no centred spinners for page content.
- **Error:** what failed, in plain words, plus a retry action. Show the technical detail in a collapsed section, mono.
- **Populated.**

Also handle: SSE disconnected (thin banner "Live updates paused — reconnecting…"), and worker offline (banner with the command to start it).

## Tables

- shadcn `Table` + TanStack Table. Sticky header, sortable columns, row hover `--surface-2`.
- Tracks table columns: `#`, artwork (32px), title/artist (two-line cell), classification, status, gate platform, duration, actions.
- **Responsive:** below 768px drop to a stacked row (title/artist + status on line one, metadata on line two); hide low-priority columns progressively rather than horizontal scrolling. Actions collapse into a row menu.
- Long titles truncate with a `title` attribute; URLs are middle-truncated.
- Buy list and Manual list always show the link and (manual) the reason; both export CSV.

## Copy

Short, literal, lower-key. "Downloaded 41 of 58", not "Success! 🎉". Button labels are verbs. Errors say what happened and what to do.

## Accessibility

Keyboard reachable everything, visible focus ring (2px `--info` outline, 2px offset), `aria-live="polite"` on the Needs-you region and run progress, real `<button>`/`<a>`, alt text on screenshots describing the blocker.

## Component checklist

Before finishing UI work, confirm:

- [ ] Uses tokens only; no raw colours or default shadcn theme leftovers
- [ ] Empty, loading, error, populated states all implemented
- [ ] Statuses go through `StatusBadge`; none are colour-only
- [ ] Numeric/data cells are mono with `tabular-nums`
- [ ] Works at 375px, 768px, 1280px; no horizontal page scroll
- [ ] Keyboard and focus states work; `aria-live` where content updates live
- [ ] Accent used only for Needs-you and the one primary action
- [ ] Paused jobs surface in: nav counter, run page pinned section, table row
- [ ] Destructive actions (Give up) confirm first
- [ ] No layout shift when live events arrive
- [ ] Reduced-motion respected
- [ ] Playwright e2e covers the main path and at least one non-happy state
