# Forensic Roadmap — the next four systems (R1–R4)

Build spec for the four remaining forensic systems on top of the shipped provenance graph
(`docs/PHASE5-PROVENANCE.md`). Each obeys the same architecture the codebase already
enforces. The copy-paste `/goal` prompt is at the very bottom.

## Shared architectural contract (every system honors these)
- **Facts observed at capture → the hashed `events.detail`; interpretations → separate, re-derivable, never hashed.** `verify()` must be **byte-identical** before/after any interpretation work — assert it on the real DB.
- **Redaction before persistence** — anything written to disk passes `redact.ts` first; fail-closed. Every new text surface gets a redaction test.
- **Additive & hash-neutral** — new facts ride in `detail` (or new nullable columns via `canonical()` null-omission); never rewrite existing rows; `SCHEMA_VERSION` stays put; new `Phase`/`ActionType` string values are hash-neutral.
- **Stay inside the ~500 ms hook budget** — ingest fast, do heavy work async/off the hook path.
- **Local-first, `127.0.0.1` only; zero new runtime deps** (Node stdlib + better-sqlite3; the UI CSP is `default-src 'none'` — no external assets, ever).
- **State honest limits in code + docs; never overclaim.**
- Ships with unit + integration tests and a review of the immutable-vs-re-derivable boundary **before** code.

---

## System 1 · R1 — Deep intent capture (the "why")

**Goal:** every step in the Story view can answer *"why did the agent do this?"* — the user's prompt is already captured (`detail.prompt`); R1 adds the agent's **reasoning** and the turn's **model/cost**.

**Grounded fact:** the Claude Code transcript `.jsonl` (path already stored, read today only for a title) carries, per assistant turn, `message.content[]` blocks including **`thinking`** (the reasoning; also a `signature` field — ignore it), plus `message.model`, `message.usage` (input/output/cache tokens), `stop_reason`. Records are keyed by `promptId`/`uuid`.

**What gets captured/built**
- At the **Stop** hook (carries `transcript_path` + `prompt_id`), **async after replying 200**, tail-read the transcript and filter to *this `prompt_id`*; extract:
  - `thinking` text → bounded + **redacted** → `detail.reasoning` on the Stop event;
  - `model` / `usage` / `stop_reason` → `detail.turn_meta`.
- **UI:** Story turn card gets a collapsible **"reasoning"** group (like `changed`/`commits`); the per-step dossier shows model + tokens.

**Immutable vs re-derivable:** the bounded reasoning digest + turn_meta are **captured facts → hashed `detail`** (durable even if Claude Code later rotates/deletes the transcript — that's the forensic point). The full verbatim transcript stays **re-derivable/on-demand** for the UI, never copied wholesale.

**Hash-neutrality:** two new `detail` keys on Stop events via `buildDetail` → prior rows unchanged.

**Key files:** new `src/transcript.ts` (parse `.jsonl`, filter by promptId, extract thinking/model/usage) · `daemon.ts` (async read at Stop, off the hook path) · `normalize.ts` + `types.ts` (`detail.reasoning`/`turn_meta`) · `redact.ts` (confirm walk coverage) · `provenance.ts` + `read-api.ts` + `ui-page.ts`. **Reuse:** `store.sessionTranscriptPath()`, the `sessionName` transcript-read pattern, `redactText`, `redactedPre`.

**Verification:** transcript-parser unit test on a fixture `.jsonl`; reasoning-with-a-secret redaction test (secret never in `detail` or `raw`); hash-neutrality on the real DB; E2E — a live turn shows its reasoning + model in the Story card.

**Risks/decisions:** read strictly off the hook path (budget); parse defensively (the transcript is not a stable API — degrade, never crash); capture only thinking text, drop the `signature`.

---

## System 2 · R2 — Ground-truth corroboration (git-anchored reconciliation)

**Goal:** don't only trust what the agent *says* it did (the hook stream) — independently check what *actually* happened against **git ground truth**, so a hook that lies, fails, or is bypassed becomes visible. Deterministic, unprivileged, no attribution ambiguity, **near-zero false positives**.

**Why not OS collectors (the rescope):** the goal is right; the earlier mechanism (fs.watch / lsof-poll / ppid-walk) was wrong. `fs.watch`/FSEvents carries **no PID** → a file change can't be attributed to the agent (editors, LSPs, npm, background procs mutate files constantly → constant false "⚠ unexplained"). A ~1 s `lsof`/`nettop` poll **structurally can't see a sub-second connection** — and exfil *is* sub-second, so the mechanism can't cash the very claim (`exfil-chain`) it exists to support. `ppid`-walk breaks on detached processes. A best-effort corroboration layer is **worse than none**: it cries wolf in the part of the product that most needs to be believed, training the user to ignore the true positives.

**What gets built**
1. **A captured ground-truth fact (hashed).** At **SessionEnd** (async, off the hook path), diff the worktree against the session's **start HEAD anchor** (already in `detail.anchor`) and record `detail.worktree_delta` on the SessionEnd event: per changed path `{path, status A/M/D, diffstat, sha256 of current content}`, **redacted**, content-addressed (hashes, not bodies). It must be captured *now* — the live worktree moves on, so reconciliation would not be recomputable later otherwise.
2. **A re-derivable reconciliation layer (NOT hashed).** Join the captured delta against the `file_write`/`file_edit` mutations captured from hooks and emit **discrepancy findings**, ruleset-keyed, in a new un-hashed table (same pattern as `risk`, recomputable via `rescore`):
   - **`ghost_mutation`** — file changed on disk with **no** corresponding hook event (the money finding: something bypassed or failed the hook stream).
   - **`phantom_mutation`** — a hook claimed a write/edit but there's **no** on-disk change.
   - **`content_mismatch`** — a hook event exists but its recorded patch **doesn't reconcile** with the actual on-disk delta.
3. **Coverage / self-blindness as a first-class concept.** A forensic tool that silently misses data is worse than none. Record + surface: hook failures, dropped/timed-out events, daemon downtime, sessions with **no git anchor** (untracked / no-repo / dirty-at-start), and any period we couldn't corroborate — as a **UI coverage strip**, not buried in logs.
4. **Honest scope (README + UI).** State plainly: *"blackbox corroborates file mutations against git ground truth. It does not observe network or process activity."* Under-promise.

**Explicitly OUT of scope (do NOT build):** `fs.watch`/FSEvents, `lsof`/`nettop` polling, `ppid`/process-tree attribution, any privileged/root collector (eBPF, EndpointSecurity, `eslogger`). Network + process visibility is a real need but requires privileged system-level monitoring — a **deferred, opt-in Tier-2** capability built only when a real user demands it, never a 1 s poll pretending to do the job.

**Immutable vs re-derivable:** `detail.worktree_delta` is a **capture-time fact** (what git shows at session end) → **hashed**; the ghost/phantom/mismatch **findings + coverage** are **interpretation** → a new un-hashed `reconciliation` table, ruleset-keyed, `rescore`-recomputable. `verify()` byte-identical.

**Hash-neutrality:** one new `detail` key on SessionEnd events (`worktree_delta`) via `buildDetail`; a new un-hashed table. Existing rows untouched; `SCHEMA_VERSION` unchanged.

**Key files:** new `src/worktree.ts` (git-diff-vs-anchor → redacted delta fact; reuse the `sessionAnchor` git-exec pattern in `mutation.ts`) · `normalize.ts` + `types.ts` (`detail.worktree_delta`) · new `src/reconcile.ts` (pure join + 3 discrepancy types + coverage) · `daemon.ts` (SessionEnd: capture delta → reconcile → persist, try/catch, off the hook path) · `store.ts` (`reconciliation` table + CRUD, mirroring `risk`) · `cli.ts` (`reconcile [--session] [--check]`, or fold into `rescore`) · `read-api.ts` + `ui-page.ts` (findings + coverage strip). **Reuse:** the risk-layer re-derivable machinery (`rescore`/`backfill`/`rules_hash`), the git-collector correlation template, `detail.anchor`, `detail.mutation`, `redact`.

**Verification:** **acceptance bar** — a clean hook-only session (agent edits files via hooks, nothing else) yields **ZERO** findings (if a clean run is noisy, the feature is wrong). `ghost_mutation` — a file changed outside the hook stream produces the finding; `phantom_mutation` — a hook write with no on-disk change; `content_mismatch` — a hook patch that doesn't match the on-disk delta. Re-derivable — `rescore` recomputes findings, `verify()` byte-identical, chain untouched. Coverage — a no-anchor session is marked **uncorroborated**; a simulated daemon-downtime gap surfaces. Redaction — a secret in a changed file never reaches `detail.worktree_delta` or `raw`.

**Risks/decisions:** **never assert attribution on a ghost** — a concurrent human edit can produce one, so report *"changed on disk, unattributed to any hook event"* and let the human judge. `.gitignore`'d paths (node_modules, build output) are **out of the corroboration set by design** — say so. No git anchor (untracked / no repo / dirty worktree at start) → mark the session **uncorroborated**, don't guess. A session with no commits / no HEAD movement still reconciles worktree state. Bound the git diff and run it async (huge repos).

---

## System 3 · R3 — Chain-of-custody hardening

**Goal:** raise the chain from tamper-**evident** to tamper-**resistant** (cryptographic signing), and ship a real **forensic case-file export** — today `report.ts` has *no* hashes or custody info.

**What gets built**
- **Ed25519 signing of chain heads** (Node `crypto`, zero deps): keypair generated on `init`, private key in `~/.blackbox/` at `0600` (outside the DB); periodically sign `{head_hash, seq, ts}`; append to a separate **append-only signatures log** (own table, un-hashed).
- **`verify` upgrade:** after the existing chain walk, verify each signed checkpoint against the public key → catches a full-chain rewrite the internal hash chain alone can't (the `store.ts:76` `[LATER]` gap; new `BreakReason`).
- **Forensic case-file export** (`blackbox report --forensic`): a self-contained evidentiary bundle — session metadata, **`verify()` status**, **head hash + the signed checkpoint covering it**, the ruleset-pinned risk verdict, the provenance story, and a manifest carrying a SHA-256 of the report itself. Markdown + optional JSON.
- **External-anchor stub** (`--anchor <url>`): POST signed heads to a remote append-only endpoint — the real off-machine resistance; designed now, wired minimally so the enterprise tier needs no migration.

**Immutable vs re-derivable:** signatures are **derived from** the immutable chain and stored **outside** it (signing must not change any event hash → `verify()` byte-identical). The case-file is a **read-time projection**.

**Hash-neutrality:** signatures live in a new un-hashed `signatures` table/log; the events chain is untouched.

**Key files:** new `src/sign.ts` (keygen, sign, verify-sig) · `verify.ts` (+ signature-checkpoint check) · `store.ts` (signatures table + CRUD) · `daemon.ts` (periodic signer, off the hook path) · `report.ts` (+ forensic case-file) · `cli.ts` (`report --forensic`, `--anchor`). **Reuse:** `hash.ts`/`chainMeta()`, the `verify()` structure, `buildReport()`.

**Verification:** sign→verify round trip; **tamper-and-catch** — rewrite the whole chain + re-sign with a *wrong* key → `verify` flags it (the demo money-shot); `verify()` byte-identical before/after signing on the real DB; case-file contains a valid head signature + matching report hash.

**Risks/decisions:** be honest — a **local** private key means whoever holds it can re-sign; **true** resistance needs the key off-machine (the `--anchor`/enterprise path). Say so in the README; don't overclaim.

---

## System 4 · R4 — The provenance graph view (Obsidian-style)

**Goal:** a visual node-link graph of a session's causality, **focusable to a single prompt/turn** — the graph the user asked for ("one for each prompt, Obsidian-like").

**Does it serve a purpose? Yes, scoped:** the Story view is linear and hides three things a graph makes obvious — (1) **fan-out/convergence** (one prompt → many steps → a few files → one commit), (2) **shared-entity relationships** (the same file/host touched by several steps = a high-degree node), (3) **risk chains as a drawn path** (the exfil combo `secret → send → external host` rendered as a red path — also the postable screenshot the architecture calls the growth engine). Honest limit: for a trivial turn (prompt → 2 edits → commit) it adds little over the list; its value is complex/risky turns.

**What gets built** (pure interpretation — no new capture, nothing hashed)
- A **graph projection** in `provenance.ts` (or a new `src/graph.ts`): from the existing story + risk evidence, emit a `SessionGraph = { nodes[], edges[] }`.
  - **Node types:** `prompt` (turn root), `step` (tool call), `file`, `commit`, `host` (external), `secret` (redacted touch), `mcp` (server). Each node carries the `seq` it drills into.
  - **Edge types:** `caused` (prompt→step), `changed` (step→file), `committed` (file→commit / step→commit), `spawned` (task step→subagent step), `read` (step→secret/file), `sent` (step→host), and a highlighted `combo` edge/path for a fired risk combo (`secret→…→host`).
  - Reuse: the provenance turns/steps/files/commits already built, plus `session_risk` combos (`ComboEvidence` carries `antecedent_seq`/`consequent_seq`/`host?`/`server?`) for the secret/host/risk nodes and the red path.
- **New read-api route** `GET /api/session/:id/graph` → `SessionGraph`; optional `?prompt=<prompt_id>` to return a single turn's subgraph.
- **UI: a third view** in the toggle — **Timeline · Story · Graph**. Render a **hand-rolled force-directed layout on `<canvas>`** (zero deps — the CSP forbids CDN libs): simple repulsion + spring-on-edges simulation via `requestAnimationFrame`, with a **static precomputed layout fallback under `prefers-reduced-motion`**. Pan/zoom; hover highlights a node's neighborhood; **click a node → opens the existing event dossier** (reuse `insertDetail`) in a side panel or scrolls the Story. A **prompt selector** isolates one turn's subgraph (satisfies "one graph per prompt"); default = whole session. Risk nodes/edges drawn in the accent red; node size ~ degree.

**Immutable vs re-derivable:** entirely a **read-time interpretation** — no capture, no schema change, `verify()` untouched.

**Hash-neutrality:** N/A (nothing written).

**Key files:** new `src/graph.ts` (pure `buildGraph(story, risk) → SessionGraph`) · `read-api.ts` (`sessionGraph()` + route data) · `daemon.ts` (route) · `ui-page.ts` (canvas renderer, force sim, third toggle, node→dossier). **Reuse:** `sessionStory`/`provenance.ts`, `ComboEvidence`, `insertDetail`, the `viewMode` toggle machinery.

**Verification:** unit-test `buildGraph` (a crafted session → expected nodes/edges; an exfil combo → a `combo` path `secret→host`); the graph route returns valid JSON with drill-in seqs; CLIENT_JS still passes the validity + template-literal-safety gates; E2E — the Graph tab renders and a node click opens the dossier; `prefers-reduced-motion` yields a static layout.

**Risks/decisions:** hand-rolled physics must stay cheap (cap node count per view; collapse huge turns); keep it genuinely useful (don't draw a graph for a 2-node turn — show a hint to use the Story); everything client-side, no data leaves the machine.

---

## Build order (four systems)
Independent, but sequence by risk/foundation:
1. **R3 (custody)** — smallest surface, no new capture, foundational to the forensic *claim*.
2. **R1 (intent)** — in-band, reuses the transcript-read + `detail` patterns; high Story-view payoff.
3. **R2 (git-anchored reconciliation)** — deterministic, unprivileged, near-zero false positives; benefits from R3's stronger `verify` and R1's richer story to reconcile against. (No OS collectors — that's deferred Tier-2.)
4. **R4 (graph)** — pure interpretation over everything above; do it last so it can render R1 reasoning, R2 corroboration, and R3 custody state as nodes/annotations.

---

## THE PROMPT — paste this as your `/goal` (3959 chars, under the 4000 limit)

```
Goal: build forensic systems R1–R4 as specified in docs/FORENSIC-ROADMAP.md, order R3 → R1 → R2 → R4. Read that doc first — it has the full spec. Blackbox = local-first forensic recorder for Claude Code: TypeScript, better-sqlite3 WAL, append-only SHA-256 chain, 127.0.0.1 only, zero deps, CSP default-src 'none'.

Orchestrate with dynamic workflows: drive each system with the Workflow tool in dynamic (self-paced) mode — fan out finders, adversarially verify each system's boundary/redaction/tests before the next.

Contract (every system): (1) Captured facts → hashed events.detail; interpretations → separate, re-derivable, never hashed. verify() must be byte-identical before/after — assert on the real store. (2) Redaction before disk (redact.ts, fail-closed); every new text surface (R1 reasoning, R2 worktree delta, R3 case-file) gets a redaction test — no secret in detail or raw. (3) Additive & hash-neutral: new facts in detail or nullable columns (canonical() null-omission); never rewrite rows; SCHEMA_VERSION unchanged. (4) ~500ms hook budget: transcript reads / signing / git-diff / reconcile run async, off the hook path. (5) Zero new deps; hand-roll the R4 graph on <canvas> (CSP forbids CDN libs). (6) State every honest limit in code+docs — never overclaim.

Per-system gate — before code, present: (a) hashed fact vs re-derivable interpretation and why; (b) hash-neutrality; (c) for R2, the reconciliation join + 3 discrepancy types + where coverage lives. Wait for that to read right, then build.

R3 (custody): Ed25519-sign chain heads (Node crypto; private key in ~/.blackbox at 0600, outside the DB) into a new un-hashed signatures table; upgrade verify to check the checkpoints; add `blackbox report --forensic` — a self-contained case-file (verify() status, head hash + signature, verdict, provenance story, SHA-256 manifest); stub --anchor <url>. Prove: sign→verify, and rewrite+re-sign-with-wrong-key → verify flags it.

R1 (deep intent): at the Stop hook, async, tail-read the transcript .jsonl (path already stored), filter to the turn's prompt_id, extract assistant thinking (drop its signature) + model/usage/stop_reason; store redacted, bounded detail.reasoning + detail.turn_meta (hashed, durable if the transcript rotates). Surface reasoning + model/tokens in the Story card + dossier.

R2 (corroboration — git-anchored, NO OS collectors): at SessionEnd (async), diff the worktree vs the session's start HEAD anchor; capture that delta as a hashed fact (detail.worktree_delta: path + status + diffstat + redacted sha256, captured now). A re-derivable, ruleset-keyed, rescore-recomputable layer joins it vs captured file_write/file_edit mutations → ghost_mutation (on-disk change, no hook — the money finding), phantom_mutation (hook, no change), content_mismatch (patch ≠ delta). Never claim a ghost is the agent (could be a human edit) → "unattributed"; no git anchor → session uncorroborated. Surface coverage gaps (hook failures, downtime, no-anchor) in a UI coverage strip. Bar: a clean hook-only session = ZERO findings. Do NOT build fs.watch/lsof/nettop/ppid/root collectors (deferred Tier-2). README states scope honestly (file mutations vs git, not network/process).

R4 (graph, pure interpretation): buildGraph(story, risk) → {nodes, edges} (nodes prompt/step/file/commit/host/secret/mcp with drill-in seqs; edges caused/changed/committed/spawned/read/sent + a red exfil-combo path); route GET /api/session/:id/graph (?prompt=<id> = one turn's subgraph); third Graph tab beside Timeline/Story: a hand-rolled force-directed canvas (static under prefers-reduced-motion), pan/zoom, hover-highlight, node-click → the dossier (insertDetail), risk red, size ~ degree. Skip trivial 2-node turns.

Bar (every system): unit + integration + redaction tests, verify()-byte-identical on the real DB, a docs/ writeup, rebuild+restart+confirm each live; keep the 160-test suite green.
```
