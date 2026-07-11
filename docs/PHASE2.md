# Phase 2 — the timeline UI (built)

The first human surface. Phases 0–1 produce a tamper-evident, redacted event stream; Phase 2 makes it *viewable* — a local, browsable, single-session timeline served from the daemon, with lightweight risk signals highlighted.

## Use it

```bash
blackbox start        # daemon must be running
blackbox ui           # opens http://127.0.0.1:7842/ in your browser
```

## What's here

| Piece | File | Role |
|---|---|---|
| **Signals** | `signals.ts` | Read-side flags derived from data already stored — `failed`, `secret-touch`, `destructive-git`, `dangerous-shell`, `new-mcp-server`. No scores/versioning/combos (that's Phase 3); this is the honest subset the data supports. |
| **Read API** | `read-api.ts` | `sessionCards` (per-session signal counts), `sessionActions` (Pre/Post paired by `tool_use_id`, signals attached), `eventDetail` (full redacted input, output hash, git detail, chain hashes). |
| **Page** | `ui-page.ts` | One self-contained HTML/CSS/JS page — no framework, no build step. Session rail → paired timeline with risk chips → click a row to expand full detail. |
| **Routes** | `daemon.ts` | `GET /` (the page) + `GET /api/sessions`, `/api/session/:id/events`, `/api/event/:seq`. |
| **Command** | `cli.ts` | `blackbox ui` opens the browser. |

## Two security properties (deliberate)

- **Reads are locked to same-origin.** `/api/*` rejects any cross-origin/browser-driven request (`Origin` / `Sec-Fetch-Site`) and sends **no** CORS headers, so a random website you visit cannot `fetch()` your forensic data. The same-origin page the daemon serves reads it fine; writes (`/hook`, `/git`) remain closed to browsers entirely. `GET /` is also `X-Frame-Options: DENY`.
- **Stored-XSS safe.** Recorded data is attacker-influenced (a malicious agent's commands/paths are arbitrary strings). Every value is rendered via `textContent` / DOM construction — never `innerHTML` with interpolation, and the served HTML template interpolates **no** recorded data server-side. So a command containing `<script>` or `<img onerror=…>` shows as text, it doesn't execute.

## Verified
Against a real 460-event session: page serves, `/api/sessions` returns signal counts (51 secret-touches, 64 dangerous-shell, 7 failed), the paired timeline renders 230 actions with 59 flagged, event detail carries the chain hashes, and cross-origin reads return 403 while same-origin returns 200.

## Deliberately not in Phase 2
Cross-session dashboard, search, the versioned risk engine + combination logic (Phase 3), report export (Phase 4), SSE/websocket live push (a 3s poll refreshes instead). Known follow-up: `sessionCards` re-scans all events per poll — fine at personal scale, wants caching/pagination before large stores.
