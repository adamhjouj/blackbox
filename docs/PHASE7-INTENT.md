# Phase 7 (R1) — Deep intent capture (the "why")

The provenance graph captured the user's *prompt* (the turn's request). R1 adds the agent's side: **what it decided and what it cost** — surfaced per turn in the Story view, so a step can answer *"why did the agent do this?"*.

## The load-bearing rule (unchanged)
> Facts observed at capture → the hashed chain. Interpretations → re-derivable.

The reasoning digest + model/usage are **captured facts** → a hashed `detail` on a **new appended `reasoning` event** (append-only, keyed to the turn by `prompt_id`). Durable even if Claude Code later rotates the transcript. The **full verbatim transcript is never copied** — the UI reads it on demand. Hash-neutral: a new append, a new `Phase 'reasoning'` string; existing rows untouched, `SCHEMA_VERSION` unchanged, `verify()` still green.

## What the transcript actually gives us (an honest correction)
The plan assumed the transcript held the agent's plaintext `thinking`. **It doesn't** (verified on Claude Code 2.1.x): `thinking` blocks are stored with an **empty `thinking` field** — the real chain-of-thought is encrypted in the opaque `signature`. So R1 captures what *is* available and honest:
- the assistant's **`text` output** (its stated response/summary for the turn) — the agent's own words for what it did, plus any non-empty thinking;
- **model / token usage / stop_reason** (`turn_meta`) — the turn's cost.

This is captured as the agent's *stated* intent, not its private thoughts — and the docs/UI say so rather than implying we read hidden reasoning.

## What shipped
- **`src/transcript.ts`** — `readTurnIntent(path, promptId?)`: **tail-reads** at most ~512 KB (never loads a multi-MB file), assigns each `assistant` record to the preceding `user` record's `promptId` (assistant records carry no promptId of their own — the bug that made the first cut capture nothing), extracts the digest + model/usage, drops the opaque thinking `signature`, and degrades to `null` on any parse hiccup — never throws.
- **`src/normalize.ts`** — `reasoningEvent()` builds the standalone event: **redacted** (`redactText`), **bounded** (`MAX_REASONING` = 4 KB) `detail.reasoning` + `detail.turn_meta`.
- **`src/daemon.ts`** — at Stop, **~1.2 s delayed + off the hook path**, `captureReasoning` reads the turn's intent and appends one reasoning event (deduped via `store.reasoningExists`, since Stop can fire twice). The delay lets Claude Code flush the turn's final record. **Not risk-scored** — a reasoning event's only possible signal is a spurious `secret-touch` from redacting its digest, which would seed false exfil-chain combos.
- **`src/provenance.ts`** — a reasoning event attaches to its turn by `prompt_id` (found across all turns, so it works even when appended out of seq order), never as a step.
- **`src/ui-page.ts`** — the Story turn card gets a collapsible **"why — agent reasoning"** group (redacted) and shows **model + token cost** on the meta line.

## Honest limits (stated in code)
- The digest is the agent's *stated* words, not its encrypted private thinking.
- Redaction is the same heuristic engine as everywhere — an un-keyed prose secret or a URL-embedded credential can slip; the UI must not present the digest as guaranteed-clean.

## Verification
`test/reasoning.test.js` (6): transcript parsing (turn assignment, signature dropped, usage summed, last-turn/unknown → null); reasoning redaction (a secret in the digest never reaches `detail`/`raw`); **out-of-order attachment** (reasoning for turn 1 appended after turn 2 still lands on turn 1) + hash-neutral; **`reasoningExists` dedup**; story surfaces reasoning + model, not as a step. Full suite **179 pass**. Adversarially verified (boundary/leak/parsing/tests) — the spurious-combo scoring and the parser bug it and the live test found are fixed. Live: a real headless turn captured the agent's explanation + 202 output tokens; the Story API renders it.
