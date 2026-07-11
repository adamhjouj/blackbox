# blackbox

A forensic **black-box recorder** for AI coding agents (Claude Code first) and MCP tools. It sits *beside* the agent as a passive observer, captures every action as a structured, tamper-evident event, scores each for risk, and renders the session as a reviewable timeline with a one-command report.

**One sentence:** *When your AI agent does something risky, know exactly what it touched — every file, every command, every MCP call — in five minutes, not five hours.*

V1 is **record + flag**: read-only, local-first, zero-config. Nothing leaves the machine. Incident response and rollback are later rungs. The only V1 metric that matters is **2-week retention** — does anyone keep it installed?

> **New agent / new session picking this up? Read this file, then `docs/ARCHITECTURE.md`.** The research/de-risk phase is done; the build has not started. Everything below is the current, reconciled state of the plan.

---

## Status — 2026-07-11

**Done:** research/de-risk, **Phase 0** (tamper-evident store + hash chain + `verify`), and **Phase 1** (live-capture daemon + secret redaction + git forensics collector). blackbox now records real Claude Code sessions automatically. See `docs/PHASE0.md` and `docs/PHASE1.md`.
**Next:** Phase 2 (timeline UI), then Phase 3 (risk rules), Phase 4 (report export).

Try it: `npm install && npm run build && node dist/cli.js init && node dist/cli.js start`, then use Claude Code and `node dist/cli.js list`.

### Repo map
```
src/                     The tool (TypeScript → dist/)
  daemon.ts              127.0.0.1 hook-receiver (POST /hook, /git) + health
  redact.ts, redact-rules.ts   fail-closed secret redaction
  git-collector.ts, watch.ts   git ref-change ground truth + session correlation
  init.ts                blackbox init/uninit (register hooks in ~/.claude/settings.json)
  store.ts, hash.ts, verify.ts, types.ts, normalize.ts   the Phase-0 store + chain
  cli.ts, paths.ts       CLI (init/watch/start/stop/status/ingest/verify/list/audit/sessions)
docs/
  ARCHITECTURE.md        The full build plan (V1 scope, schema, storage, risk engine, roadmap)
  PHASE0.md, PHASE1.md   What each shipped phase does + honest limits
  DAY1-FINDINGS.md       Verified hook behavior on 2.1.206 (the make-or-break test, passed)
  FORENSIC-COLLECTORS.md What we capture at each tier, how attribution works, what's deferred
experiments/             Reproducible hook-reality test, fixtures, four-collectors demo
README.md                This file — orientation entry point
```

---

## Decisions locked (with reasoning)

- **Language: TypeScript/Node.** One runtime for the localhost hook receiver + UI; matches the Claude Code ecosystem and hook examples.
- **Store: SQLite (WAL), `better-sqlite3`.** Single local file, indexed queries for the timeline, handles concurrent async-hook writes. No JSONL hedge.
- **Tamper-evidence: hash chain** (each event hashes the previous). Detects tampering locally; true tamper-*resistance* (remote anchoring) is a later/paid tier — do not overclaim.
- **Collector scope = Tier 1 only for V1** (see `docs/FORENSIC-COLLECTORS.md`):
  - Claude Code hooks (HTTP + `async`) — intent + result, verified.
  - git `reference-transaction` hook — ground-truth ref changes, verified.
  - `lsof`/ppid poller — observed network + process attribution, unprivileged, **labeled lossy**.
  - Tier 2 (Endpoint Security / `eslogger`, kernel-level, root + Full Disk Access) is **deferred** — documented, not built. Reason: robust Tier 2 = root daemon + un-automatable FDA onboarding + version-fragile parser + real attack surface, and it doesn't change what V1 tests.
- **Attribution correction (important):** build the process tree from `(pid, pidversion)` + `parent_audit_token` (or ppid in Tier 1) — **never `responsible_audit_token`**, which live-tested as unreliable (resolves to self/Terminal on `posix_spawn` disclaim).
- **Redaction is a fail-closed subsystem, not a line item.** Redact at capture (before first write); store output hashes not bodies by default; if redaction throws, drop the field to a hash. An under-redacted event is a breach in a *security* tool.
- **No blocking in V1.** Hooks *can* block (exit-2 / `permissionDecision`), but we stay a recorder — blocking creates the "it broke my agent" uninstall risk we're avoiding.

### Verified facts worth not re-deriving
- Hooks deliver `tool_use_id`, `duration_ms`, full `tool_response`, `PostToolUseFailure`, and subagent `agent_id`/`agent_type` — live-confirmed. Fire in headless `-p` mode.
- Field drift vs docs: live payloads use `tool_response`/`error` where docs say `tool_output`/`tool_error`. **Store raw payload verbatim; normalize with a tolerant parser.**
- `reference-transaction` fires on every ref update (commit/amend/reset/branch), with old→new SHAs. Version floor for `duration_ms`: Claude Code ≥ 2.1.119.

---

## Next steps — Phase 2 onward

Phases 0 and 1 are built (`docs/PHASE0.md`, `docs/PHASE1.md`). Remaining:
- **Phase 2 — timeline UI** on `127.0.0.1`, reading the store; the flagged-session view is the growth artifact.
- **Phase 3 — risk engine** — the 5 high-precision rules + combination highlighting over this event stream.
- **Phase 4 — report export** — one-command Markdown incident report.
- **Hardening follow-ups** — durable (redacting) spool + launchd auto-start so daemon-down loss is closed; `--global` git watch broader testing.

**Pending doc task:** `docs/ARCHITECTURE.md` still describes collectors loosely (pre-Tier-1) and repeats the docs' `tool_output` field name — reconcile it with what shipped (see `docs/PHASE1.md`).

---

## Environment notes (for whoever/whatever runs here)
- This workspace is a **standalone clone** of `github.com/adamhjouj/blackbox` on `main`. Push/pull works via SSH (`adamhjouj`). `gh` CLI is **not** logged in.
- The original parent repo lives under `a local directory`, which macOS TCC blocks from terminal access — don't try to reach it.
- Tier-2 tools (`eslogger`) need root; the machine has the full native stack (`eslogger`, `fs_usage`, `dtrace`, `lsof`, `tcpdump`, git 2.50) if deep-mode work resumes.
