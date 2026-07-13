# Phase 2 — the Blackbox viewer (built)

The viewer turns the tamper-evident event stream into a personal, local session dashboard. It is served by the recorder daemon and remains a zero-runtime-dependency, self-contained page.

## Use it

```bash
blackbox start
blackbox ui           # http://127.0.0.1:7842/
```

## Information architecture

- **Dashboard (`#/`)** — local welcome name, recorder status, global session/evidence search, a horizontal recent-session shelf, and an all-session grid.
- **Overview** — deterministic outcome summary, actionable findings, blast radius, ordered containment, and integrity/corroboration status.
- **Turns** — prompt-first work records with search, risk/tool filters, full user prompt, an independently collapsible agent response/reasoning digest, model/usage metadata, changed files, commits, subagents, signals, nested actions, next-flag navigation, and evidence links.
- **Graph** — a first-class causal investigation workspace with focused and whole-session lenses, search/type highlighting, pan/zoom/fit, explicit node inspection, directory expansion, and direct links to activity and raw evidence.
- **Evidence** — sensitive paths, outbound hosts, ordered containment, changed files, reconciliation/completeness, git/chain integrity, and complete event dossiers (explanation, risk, diff/content state, input/output commitments, git, correlation, redactions, hashes, and raw redacted facts).
- **Hash routing** — every session tab and open event dossier has a restorable URL. Browser Back closes contextual evidence and returns through session navigation without losing turn filters or expansion state.

## Implementation

| Piece | Role |
|---|---|
| `ui-page.ts` | Concatenates the modular source into the single served document. |
| `ui/styles.ts` | Monochrome design tokens, dashboard/session layouts, drawer, graph, responsive and reduced-motion rules. |
| `ui/state-router.ts` | Safe DOM helper, hash router, local profile preference, polling, loading/error state, and shared state. |
| `ui/dashboard.ts` | Welcome surface, search ranking, session shelf/grid, and empty states. |
| `ui/session.ts` | Compact overview and the complete, filterable Turns investigation surface. |
| `ui/evidence.ts` | Blast radius, integrity, event dossier drawer, and raw evidence presentation. |
| `ui/graph.ts` | Interactive, accessible explorer for the server-positioned deterministic causal DAG. |

The dashboard name comes from `GET /api/profile`, which derives a display suggestion from the local OS username. An edited value is kept only in `localStorage` under `blackbox.displayName`; it never enters SQLite or the forensic chain.

Historical sessions recorded before `UserPromptSubmit` or reasoning capture existed are repaired at read time from their local Claude transcript and bounded sidechains. Recovery is lazy, cache-aware, file/byte/depth bounded, secret-redacted, and code-point truncated. Tool-result bodies are never mistaken for prompts, captured chain facts remain authoritative, and the immutable forensic chain is not changed. Every retained turn receives one shared honest display title used by both Turns and Graph; when the host emitted no textual prompt, the label explicitly describes subagent/recorded activity instead of fabricating a prompt.

## Security properties

- **Same-origin only.** `/api/*` rejects forged browser reads and sends no permissive CORS headers. The page cannot be framed.
- **Stored-XSS safe.** Recorded prompts, commands, paths, tool output, and metadata are hostile input. The viewer uses DOM creation and `textContent`, never HTML-string insertion.
- **Restrictive CSP.** No external script, font, image, frame, form action, or base URL is permitted. The visual system uses system fonts, CSS, and inline-created SVG only.
- **Read-only UI.** Profile editing changes browser-local state. The viewer does not write to the forensic store.

## Live behavior

The self-scheduling three-second poll fingerprints cards and session projections before rendering. It preserves the active route, dashboard query, filters, expanded turns, open evidence, graph selection/viewport, and scroll position during live updates. Route transitions intentionally reset to the top so a session never opens partially hidden under the sticky header.

## Verification

- The full Node 24 suite covers the recorder, projections, transcript recovery, dashboard/session UI, graph, dossier, routing, and security boundaries.
- UI smoke gates parse the emitted client, enforce the no-template-interpolation convention, reject unsafe HTML APIs, and check the responsive/routed surfaces.
- Browser verification against an isolated copy of a real 12k-event store covers dashboard search/cards, overview, activity expansion, evidence drawer, causal trace, editable display name, and desktop/mobile navigation.
- At 1280×720 and 390×844 the page has no horizontal document overflow; the mobile layout stacks panels and presents dossiers as bottom sheets.
