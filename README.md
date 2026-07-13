# blackbox

A forensic **black-box recorder** for AI coding agents (Claude Code first) and MCP tools. It sits *beside* the agent as a passive observer, captures every action as a structured, tamper-evident event, scores each for risk, and renders the session as a reviewable timeline with a one-command report.

**One sentence:** *When your AI agent does something risky, know exactly what it touched — every file, every command, every MCP call — in five minutes, not five hours.*

V1 is **record + flag**: read-only and local-first. The one thing that can leave the machine is **external anchoring**, now **on by default**: `blackbox init` finds a git remote and pushes tiny signed head *receipts* there, so a store-rewriting attacker can be *proven* wrong. Only the receipts travel — never events, code, or secrets — and you can drop to an explicit, clearly-labeled **local-only** posture (`blackbox init --local-only-anchor`) if you accept the reduced tamper-evidence. Incident response and rollback are later rungs. The only V1 metric that matters is **2-week retention** — does anyone keep it installed?

> **New agent / new session picking this up? Read this file, then `docs/ARCHITECTURE.md`, then the `docs/PHASE*.md` for each shipped system.** The recorder and four forensic systems on top of it are built; work now is hardening + new forensic capability.

---

## Status

**Shipped — the V1 recorder plus four forensic systems (R1–R4):**
- **Phase 0–4** — tamper-evident hash-chained store + `verify`; live-capture daemon; fail-closed secret redaction; git-forensics collector; localhost timeline UI; versioned risk engine (rulesets r1/r2) with exfil-chain / injection / tool-poisoning combos; one-command Markdown report.
- **R1 · deep intent** — the agent's stated reasoning + model/token cost per turn (`docs/PHASE7-INTENT.md`).
- **R2 · reconciliation** — git ground truth vs the hook stream: ghost / phantom / content-mismatch (`docs/PHASE8-RECONCILIATION.md`).
- **R3 · custody** — Ed25519 chain-head signing + anti-deletion watermark + forensic case-file (`docs/PHASE6-CUSTODY.md`).
- **R4 · provenance graph** — a deterministic Sugiyama causal DAG / re-traceable session trace (`docs/PHASE9-GRAPH.md`).
- **W0 · hardening** — the ReDoS / fsmonitor / redaction audit fixes, streaming `verify`, bounded transcript reads, a schema-version guard, and PreCompact/Notification capture.

**Next (planned):** recording integrity (anti-forensics detection + a capture-coverage ledger), external anchoring (off-machine custody), deeper capture (environment snapshot, file history), and analytics/IR (corpus search + blast-radius containment).

Try it (from source): `npm install && npm run build && node dist/cli.js init && node dist/cli.js start` — then use Claude Code and open the UI with `node dist/cli.js ui`. Installed as a bin, the same commands read `blackbox <cmd>`.

### Repo map
```
src/                     The tool (TypeScript → dist/)
  daemon.ts              127.0.0.1 hook-receiver (POST /hook, /git) + read API + UI
  store.ts, hash.ts, verify.ts, types.ts, normalize.ts   the append-only hash-chained store
  redact.ts, redact-rules.ts   fail-closed secret redaction (+ structure-anchored context rules)
  git-collector.ts, watch.ts, git-safe.ts   git ref-change ground truth + hardened git calls
  mutation.ts, worktree.ts, reconcile.ts     file-change facts + R2 git reconciliation
  risk-engine.ts, risk-rules.ts, injection.ts, explain.ts   the risk layer + plain-English explains
  transcript.ts, provenance.ts, graph.ts     R1 intent · the session story · R4 causal DAG
  sign.ts                R3 Ed25519 checkpoint signing + watermark
  read-api.ts, ui-page.ts   read-time projections + the single-file localhost UI
  init.ts, autostart.ts, cli.ts, paths.ts   install/hooks/launchd + CLI
docs/
  ARCHITECTURE.md        The master build plan (V1 scope, schema, storage, risk engine, roadmap)
  PHASE0–4, PHASE5–9     What each shipped phase/system does + its honest limits
  DAY1-FINDINGS.md       Verified hook behavior on 2.1.x (the make-or-break test, passed)
  FORENSIC-COLLECTORS.md What we capture at each tier, how attribution works, what's deferred
experiments/             Reproducible hook-reality test, fixtures, four-collectors demo
README.md                This file — orientation entry point
```

---

## Decisions locked (with reasoning)

- **Language: TypeScript/Node.** One runtime for the localhost hook receiver + UI; matches the Claude Code ecosystem and hook examples.
- **Store: SQLite (WAL), `better-sqlite3`.** Single local file, indexed queries for the timeline, handles concurrent async-hook writes. No JSONL hedge.
- **Tamper-evidence → resistance: hash chain + Ed25519 signing** (R3). Each event hashes the previous (local tamper-*evidence*); `blackbox init` also generates a signing key (`~/.blackbox/signing.key`, 0600) and the daemon signs the chain head at session boundaries, plus an out-of-DB `signing.head` watermark. So `blackbox verify` catches a rewrite re-signed with a different key **and** signature deletion/rollback by a DB-only writer. **Honest limit:** it's all local — an attacker with full `~/.blackbox` write access (DB + key + watermark) can re-sign; *true* off-machine resistance is remote anchoring (`report --anchor`, a later/paid tier). Do not overclaim.
- **Ground-truth corroboration: git-anchored reconciliation** (R2). At SessionEnd, `blackbox reconcile` cross-checks the hook stream against what git shows actually changed on disk (`ghost`/`phantom`/`content_mismatch`), with a SessionStart dirty baseline so pre-existing edits aren't blamed on the agent. **Honest scope:** corroborates *file mutations vs git only* — it does **not** observe network or process activity, and a ghost is reported *unattributed* (a shell command / human / tool), never asserted to be the agent. OS-level (network/process) visibility is a deferred, opt-in Tier-2 capability.
- **Collector scope = Tier 1 only for V1** (see `docs/FORENSIC-COLLECTORS.md`):
  - Claude Code hooks (HTTP + `async`) — intent + result, verified and shipped.
  - git `reference-transaction` hook — ground-truth ref changes, verified and shipped.
  - `lsof`/ppid network+process poller — prototyped in the four-collectors demo but **cut from the shipped product**: a ~1s poll can't attribute a sub-second exfil, so it would cry wolf exactly where the tool must be believed. R2 reconciles file mutations against git instead; network/process visibility is a deferred, opt-in Tier-2 capability.
  - Tier 2 (Endpoint Security / `eslogger`, kernel-level, root + Full Disk Access) is **deferred** — documented, not built. Reason: robust Tier 2 = root daemon + un-automatable FDA onboarding + version-fragile parser + real attack surface, and it doesn't change what V1 tests.
- **Attribution correction (important):** build the process tree from `(pid, pidversion)` + `parent_audit_token` (or ppid in Tier 1) — **never `responsible_audit_token`**, which live-tested as unreliable (resolves to self/Terminal on `posix_spawn` disclaim).
- **Redaction is a fail-closed subsystem, not a line item.** Redact at capture (before first write); store output hashes not bodies by default; if redaction throws, drop the field to a hash. An under-redacted event is a breach in a *security* tool.
- **No blocking in V1.** Hooks *can* block (exit-2 / `permissionDecision`), but we stay a recorder — blocking creates the "it broke my agent" uninstall risk we're avoiding.

### Verified facts worth not re-deriving
- Hooks deliver `tool_use_id`, `duration_ms`, full `tool_response`, `PostToolUseFailure`, and subagent `agent_id`/`agent_type` — live-confirmed. Fire in headless `-p` mode.
- Field drift vs docs: live payloads use `tool_response`/`error` where docs say `tool_output`/`tool_error`. **Store raw payload verbatim; normalize with a tolerant parser.**
- `reference-transaction` fires on every ref update (commit/amend/reset/branch), with old→new SHAs. Version floor for `duration_ms`: Claude Code ≥ 2.1.119.

---

## Next steps — the forensic roadmap

Phases 0–9 / R1–R4 are built (see the `docs/PHASE*.md`). The next milestone, in priority order:
- **Recording integrity** — anti-forensics detection (a ruleset-`r3` flag for the agent attacking the recorder: killing the daemon, editing `~/.blackbox`, disabling hooks, rewriting history) + a capture-coverage ledger (daemon-lifecycle facts + a transcript-completeness reconciliation, so silent capture loss is *visible and attributable*).
- **External anchoring (on by default)** — signed head *receipts* to a git ref / file / URL outside `~/.blackbox`, so a store-rewriting attacker can be *proven* wrong. `blackbox init` requires one (auto-resolving the repo's git remote and auto-pushing receipts to it) and **fails loudly** if none can be found; `--local-only-anchor` is the explicit, clearly-labeled reduced-security fallback (receipts stay on this machine). The only thing that leaves the machine — and only the receipts do.
- **Deeper capture** — a SessionStart environment/toolchain snapshot (versions, MCP inventory, hooks hash) and file history / point-in-time reconstruction from the blob store.
- **Analytics & IR** — corpus-wide FTS search, a blast-radius containment checklist (ARCHITECTURE §11), and a fleet overview strip.

Durable spool, rollback/containment (§12), and Tier-2/3 OS collectors remain deliberately deferred (see `docs/ARCHITECTURE.md` and `docs/FORENSIC-COLLECTORS.md`).
