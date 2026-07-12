# Phase 5 — The Re-Traceable Provenance Graph (the "session story")

Phases 0–4 made blackbox a tamper-evident recorder with a risk engine and a flat timeline. But a flat list of tool events reads like a *log printer*: you can't retrace **cause**. Phase 5 turns the stream into a causal narrative — **user prompt → the steps the agent took → the files it changed → the commit** — rendered as a scrubbable per-turn story. It also, as a side effect, cures the findability problem (a single file change was a needle in a 1,600-event haystack).

## The load-bearing rule (unchanged)
> **Facts observed at capture time → the hashed `detail` column. Interpretations (the graph, scores, verdicts) → a separate, re-derivable layer, never hashed.**

The provenance graph is an **interpretation** — projected from the immutable chain at read time, exactly like `risk-engine.ts` and `explain.ts`. `verify()` is byte-identical before and after (proven on the live store and in tests). The only *new captured facts* are two small additions to `detail`.

## Two new capture-time facts (hash-neutral, no schema migration)
Both ride in the existing `detail` bag via `buildDetail()` — the same mechanism as `mutation`/`anchor`/`description`. `canonical()` omits absent keys, so **every already-recorded row hashes identically**; no `events` column added, `SCHEMA_VERSION` untouched. Verified: the live 4.9k-event chain still verifies with the new build, and a unit test asserts earlier rows' hashes are byte-identical after appending prompt/parent events.

1. **`detail.prompt` — the turn's intent.** `UserPromptSubmit` is now registered (`init.ts`) and mapped to a new phase `'prompt'` (`types.ts`, `normalize.ts`). The redacted, bounded (2 KB) prompt is stored keyed to the turn by `prompt_id`.
   - **Field-name drift, handled.** The docs call the field `user_input`; live Claude Code payloads have used `prompt`. We read **either**, and added `user_input` to redaction's `WALK_FIELDS`, so a secret pasted into a prompt is scrubbed under **either** name before it touches `detail` or `raw` (tested both ways). This is the third doc-vs-reality field discrepancy the project has hit — the tolerant parser earns its keep again.
   - Empirically verified: the hook's `prompt_id` **equals** the transcript's `promptId` and is shared across a whole turn (all 30 records of a turn carried it), so turn-grouping by `prompt_id` is exact.

2. **`detail.parent_tool_use_id` — the subagent link.** Read opportunistically (null → omitted, hash-neutral). It is **not a documented hook field yet**, so provenance does not depend on it: subagent steps are identified by `agent_type != 'main'` and flagged `is_subagent`, and the UI indents them. If Claude Code later exposes the parent link, precise nesting comes for free.

## The re-derivable layer — `src/provenance.ts`
A **pure** function: `buildStory({ actions, detailBySeq, … }) → SessionStory`. No store, no clock, no I/O — so it unit-tests without a database. It reuses `sessionActions` (Pre/Post pairing + risk), `prompt_id` grouping, `explain.actionSummary`, the git-collector's commit correlation (`detail.git`), and `session_risk`.

- **Turn** = one `prompt_id` group: `{ prompt, steps[], files_changed[], commits[], flagged }`.
- **Step** = a paired action; a mutation on its POST event becomes a `FileChange`; a commit (a `GitRefTransaction` event carrying `detail.git.commit.sha`) is surfaced as an **outcome**, not a step.
- **Files-changed rollup**: per-turn and per-session, deduped by path, churn summed, latest seq kept for click-through.
- **Graceful degradation**: sessions recorded before prompt capture still split into turns by `prompt_id` — they just carry a null `prompt` ("intent not captured"), which is honest, not a failure. Confirmed on the real "building" session: 51 turns, 1086 steps, **15 files changed** correctly rolled up.

`sessionStory()` (`read-api.ts`) gathers the inputs and caches on `head_seq` like the other read functions; the daemon serves `GET /api/session/:id/story`.

## The UI — a "Story" view (`ui-page.ts`)
A **Timeline ⇄ Story** toggle in the main pane; **Story is the default lens**. Each turn is a card: the prompt at top, an outcome band (`N steps · duration · N flagged`), the **files-changed rollup** (each file `+/−`, click → the diff), commit rows, and a collapsible step list. Every file / commit / step expands the **same dossier** the timeline uses (`insertDetail`), so the diff + chain hashes are one click away. Full-rebuild on data change, fp-gated so idle polls cost zero DOM work; per-turn expansion persists across rebuilds. The flat Timeline is unchanged, for skeptics.

## Bonus fix — the timeline finally shows diffs
A latent bug surfaced during the build: timeline rows expand their **Pre** event, but the mutation fact is recorded on the **Post** event — so expanding an edit showed **no diff** (a real cause of "I can't see what changed"). `eventDetail` now falls back to the paired Post's mutation (`store.postFor`), so both the timeline **and** the story show the diff. Verified: expanding a Pre edit now renders `available (patch, +31/−0)`.

## Verification
- **Unit** (`provenance.test.js`, 6): turn projection, subagent nesting, file rollup, skipped-mutation status, flag rollup, null-prompt_id commit attachment.
- **Capture** (`prompt-capture.test.js`, 9): prompt-phase event, both field names, bounded length, **secret-in-prompt redaction** (detail + raw), parent link, hash-neutrality.
- **Integration** (`story-integration.test.js`, 2): realistic hook payloads → `normalizeAndCapture` → `store.append` → `sessionStory` yields the right turns/prompts/files; `verify()` still green; secret never reaches the story.
- **Live**: new-build daemon on the real DB, `GET /api/session/:id/story` over HTTP returns the rollup; `verify` = chain intact (4945 events, 81 sessions). Full suite **160 pass / 0 fail**.
- **Note**: the `UserPromptSubmit` hook is read at session start, so prompt capture applies to **new** Claude Code sessions; existing sessions still get full file/commit stories (prompt shown as "not captured").

## Files
`init.ts` · `types.ts` · `normalize.ts` · `redact.ts` (WALK_FIELDS) · **`provenance.ts` (new)** · `read-api.ts` (`sessionStory`, Post-mutation fallback) · `store.ts` (`postFor`) · `daemon.ts` (route) · `ui-page.ts` (Story view) · tests.

---

# Roadmap — remaining forensic directions (remembered, sequenced)

Recorded so they aren't lost; not built this round. Each is a clean rung on the same architecture (capture-time facts hashed; interpretations re-derivable; local-first; in-band unless noted).

- **R1 · Intent capture (deep).** The flagship captures the *prompt*; deepen it by parsing the transcript `.jsonl` (path already stored, read only for a title today) on demand for the agent's **reasoning/thinking** and tool-result context, so each step shows a recorded "why." In-band, no new permissions. Natural follow-on to the Story view.
- **R2 · Ground-truth corroboration ("the agent can't lie").** Reconcile self-reported hooks against what the machine *actually* did — the unwired Tier-1 collectors in `FORENSIC-COLLECTORS.md` (FSEvents file-watch, `lsof`/`nettop` egress poll, ppid process-tree). **Deferred per the in-band-only decision**; revisit as an opt-in "deep mode." Even now, git corroboration can be strengthened in-band.
- **R3 · Chain-of-custody hardening.** Elevate tamper-*evidence* → tamper-*resistance*: Ed25519 signing of chain heads + periodic external anchoring (`store.ts:76` already flags this `[LATER]`), and a real **forensic case-file export** — today `report.ts` emits a risk summary with *no* hashes/custody. Bundle `verify()` status + head hash + signature.

**Additional high-value DFIR rungs:**
- **Filesystem point-in-time reconstruction** — rebuild a file's state at any `seq` from the content-addressed `blobs` + git anchor (MACB-style). The blob store already makes this cheap.
- **Environment/toolchain snapshot at SessionStart** — MCP inventory, hook config, package/lock + Node/Claude-Code versions, model. Today only git `HEAD`+branch is snapshotted.
- **Anti-forensics detection** — a high-signal rule for the agent attacking the recorder (killing the daemon, editing `~/.blackbox`, rewriting git history, disabling hooks). Feeds the risk engine.
- **Blast-radius / IR** (ARCHITECTURE §11) — from a flagged session, an ordered "rotate X · revert commit Y · review file W" checklist. The provenance graph makes this a direct walk.
