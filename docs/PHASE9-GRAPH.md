# Phase 9 (R4) — The provenance graph (Obsidian-style)

The Story view is linear. A graph shows what a list hides: **fan-out** (one prompt exploding into many steps), **shared-entity relationships** (a file touched by several steps is a high-degree node), and a **risk chain as a drawn path** (the exfil combo `secret → send → host` rendered in red — the postable screenshot). R4 adds a third **Graph** tab beside Timeline and Story.

## The load-bearing rule
Entirely a **read-time interpretation** — no capture, no schema change, nothing hashed, `verify()` untouched. `buildGraph` is a pure projection of the existing story + risk combos; `sessionGraph` only reads. This is the cleanest of the four systems: it invents no new facts, just a new lens on the ones already recorded.

## The projection (`src/graph.ts`)
`buildGraph(story, combos, promptId?) → { nodes, edges }` at two resolutions:
- **Session overview** (default): `prompt` · `file` · `commit` · risk nodes; steps are aggregated (a prompt links straight to the files it changed). Stays readable for a big session (~76 nodes for a 51-turn session, not ~1000).
- **Single turn** (`?prompt=<id>`): `prompt` · every `step` · `file` · `commit` — the full causal detail of one turn.

**Node types** `prompt · step · file · commit · host · secret · mcp`, each with a drill-in `seq`. **Edge types** `caused · changed · committed · spawned · read · sent · combo`. A fired **exfil-chain** combo adds a `secret` node (at the secret-touch seq), a `host` node, and a red **combo** path — anchored to the step nodes in the detailed view or to the owning prompt in the overview (so the risk shows up at both resolutions, even when the combo evidence carries no structured host). Subagent steps nest under their spawning `Task` via a `spawned` edge. Node `degree` is computed so the UI can size by connectedness.

Wired: `read-api.sessionGraph` (story + `session_risk` combos → `buildGraph`); daemon route `GET /api/session/:id/graph` with optional `?prompt=`.

## The UI (`src/ui-page.ts`)
A **hand-rolled force-directed canvas** — zero deps (the CSP forbids CDN libs, so no d3/Cytoscape). A simple repulsion + spring + center-gravity simulation runs on `requestAnimationFrame` (~240 frames then freezes); under `prefers-reduced-motion` it computes a static layout synchronously and draws once. Nodes are coloured by type and **sized by degree**; risk nodes/edges are the accent red, the combo path dashed. **Pan** (drag), **zoom** (wheel, around the cursor), **hover** highlights a node's neighbourhood (dims the rest), and **clicking a node opens its dossier** below the canvas (reusing the timeline's `insertDetail`). A **focus** selector switches between the whole session and a single turn's subgraph. A trivial (≤1-node) graph shows a hint to use the Story instead. The rAF loop and the window-resize listener are torn down on every view/session switch (no leak, no draw-after-teardown).

## Files
`src/graph.ts` (new) · `src/read-api.ts` (`sessionGraph`) · `src/daemon.ts` (`/graph` route) · `src/ui-page.ts` (Graph tab + canvas renderer) · `test/graph.test.js` (7).

## Verification
7 unit tests: overview (prompt→files+commit), detailed (prompt→steps→files), the exfil combo (secret+host+red path, steps marked risky), a combo with no structured host still anchoring to the prompt, degree counting, subagent `spawned` nesting, and the trivial-graph case. `CLIENT_JS` still passes the validity + template-literal-safety gates. Full suite **201 pass**. Live: the `/graph` route serves a 76-node overview and an 8-node single-turn subgraph; the UI renders the canvas with pan/zoom/hover and node-click drill-in.
