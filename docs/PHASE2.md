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

---

## Phase 2.5 — the redesign (tactical telemetry)

The plumbing above is unchanged; the page was rebuilt to look like what it is — a flight recorder. `docs/ARCHITECTURE.md` §8 makes the flagged-session view the growth artifact ("clean enough that people screenshot it"), so the whole surface is now an industrial-brutalist forensic instrument: dark CRT substrate, a single hazard-red accent, zero border-radius, uppercase monospace chrome, and a huge grotesque flag numeral. Governing rule — **chrome is uppercase; evidence is verbatim**: labels/IDs are transformed, but recorded commands, paths, and hashes are never case-touched (a visually uppercased shell command would misrepresent the evidence).

What changed, all inside `ui-page.ts` (still one self-contained page, no framework, no build step, no new deps):

- **HUD status bar** — live `EVENTS / HEAD / SESSIONS / STORE / HOST` from `/health`, plus a `REC · IDLE · LINK` indicator (the one green element; goes red when the daemon is unreachable).
- **Session manifest** — numbered records, flagged count as a red numeral (clean sessions read `CLEAN`, never green), project basename from the new `cwd` field, `LIVE` for sessions active in the last 10s.
- **Verdict hero** — the screenshot moment: macro flag numeral, Phase-3 risk stamp when present, and a `HASH-CHAINED · SEQ a→b · APPEND-ONLY` integrity strip with a barcode rendered from the session id. Self-identifies (brand + id inside the bar) so a crop still explains itself. A zero-flag session is deliberately composed too (`00 / NOMINAL / [ CLEAN ]`).
- **Timeline** — a 9-column table (SEQ · TIME · AG · ST · TYPE · TOOL · TARGET · DUR · SIGNALS), `prompt_id` turn dividers, a subagent lane (`agent_type`), and a four-tier signal ladder — **solid / outline / inverse-video / neutral**, one hue, legible under color-blindness (secret-touch is styled as a literal redaction bar). Flat and seq-ordered by design; a recorder must never hide or reorder rows.
- **Forensic dossier** — expanded rows lead with the chain-link integrity seal (`PREV → HASH`, "edit any row and `blackbox verify` breaks here"), structured git/correlation/risk sections, output reframed as provenance (elided, hash + bytes), and `[REDACTED:…]` placeholders highlighted via safe text-node splitting (no `innerHTML`).
- **States & motion** — skeleton loaders, an armed-recorder empty state, a non-silent error strip (fetch failures now surface instead of being swallowed), custom-eased staggered entry that plays **once** (see below), keyboard operability, focus rings, and `prefers-reduced-motion` support.

### Poll-safe rendering (the load-bearing mechanic)
The 3s poll used to wipe and rebuild both panes, which would strobe the entry animation and drop scroll/selection every tick. Now each pane compares a JSON fingerprint and does **zero DOM work** when nothing changed; a live session reconciles rows by index against the append-only action list (a `Pre` paired by its `Post` patches its cells in place; genuinely new rows append and animate once). Expanded dossiers persist across polls instead of re-fetching. `setInterval` became a self-scheduling `setTimeout` so a slow fetch can't overlap the next poll.

### Constraints honored
Zero changes to `daemon.ts` — the CSP (`default-src 'none'`, no `img-src`/`font-src`) still blocks every external asset, so fonts are system stacks and all texture is pure CSS gradients / an inline SVG element. The two security properties above are intact: reads stay same-origin (cross-origin → 403), and recorded strings stay inert (`textContent`/DOM only, class names never derived from data).

### Verified
Headless-Chromium behavioral harness against a seeded store: hostile payloads (`<img onerror>`, `</script><script>`, `${}`, `mcp__<script>…`) render as inert text — no dialogs, no injected nodes, clean console; idle polls preserve DOM identity, scroll position, and open dossiers; live appends animate exactly once and leave existing rows and a live text selection untouched; `[REDACTED:…]` highlights; reduced-motion emulation disables all animation; no horizontal scroll at 700px. Security regression gates pass unchanged: `GET /` CSP byte-identical, cross-origin / bad-host `/api/*` → 403, and `ui-page.ts` contains no `innerHTML`/`insertAdjacentHTML`/`document.write`.
