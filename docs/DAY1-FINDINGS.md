# Day-1 hook verification — findings

**Date:** 2026-07-11 · **Claude Code version tested:** 2.1.206 · **Method:** live headless sessions with real hooks registered (see `experiments/day1-hooks/`), cross-checked against the official hooks reference (code.claude.com/docs/en/hooks) and the Claude Code changelog by four parallel research agents.

This is the Section 2.3 test from `ARCHITECTURE.md`, executed. **Verdict: the collector design is GO as specified.** Every load-bearing claim held. Two field-naming discrepancies between docs and live payloads were found (details below) — build the normalizer tolerant to both names.

---

## Confirmed live (observed in captured events, not just docs)

| Claim (ARCHITECTURE.md) | Result | Evidence |
|---|---|---|
| `type: "http"` hooks POST event JSON to a local URL | ✅ **Works.** 10/10 events delivered to `127.0.0.1:7842` | `fixtures/http-delivered-events.jsonl` |
| `async: true` accepted on http hooks | ✅ Accepted; docs confirm "run in background without blocking" (+ an `asyncRewake` option exists) | live run + hooks reference |
| `matcher: "*"` catches MCP tools (`mcp__<server>__<tool>`) | ✅ `mcp__hooktest__echo` captured | `fixtures/events-run1-basics.jsonl` |
| `tool_use_id` joins Pre↔Post↔Failure | ✅ Present on all three phases | all fixtures |
| `duration_ms` on Post/Failure | ✅ Present | all fixtures |
| `tool_response` carries full output | ✅ Bash: `{stdout, stderr, interrupted, isImage, ...}` (structured, not a string); MCP: the MCP content array, passed through unvalidated | fixtures |
| `PostToolUseFailure` exists and fires | ✅ Fired on failed Read; payload has `error` (string), `is_interrupt`, `duration_ms`, full `tool_input` | run 1 |
| Subagent actions attributed | ✅ Subagent tool calls carry `agent_id` + `agent_type`; bonus `SubagentStart`/`SubagentStop` events with the same fields | `fixtures/events-run2-subagent.jsonl` |
| Hooks fire in headless `-p` mode | ✅ All events fired (docs note: `PermissionRequest` does NOT fire in `-p` mode — irrelevant for recording) | both runs |
| `session_id`, `transcript_path`, `cwd`, `permission_mode` on every tool event | ✅ | all fixtures |
| MCP stdio = newline-delimited JSON-RPC, implementable dep-free | ✅ `echo-server.mjs` (~60 lines, zero deps) worked first try | `experiments/day1-hooks/echo-server.mjs` |

## Discrepancies: docs vs. live payloads (live wins — 2.1.206)

1. **Success output field.** Live payloads use **`tool_response`** (object for Bash, array for MCP). The current docs page describes a `tool_output` string. → Normalizer must accept **both** names and both shapes (string | object | array).
2. **Failure fields.** Live: **`error`** (string) + **`duration_ms`**. Docs describe `tool_error` + `duration` (seconds). → Accept both names; treat `duration` (if ever seen) as seconds, `duration_ms` as ms.

**Design consequence:** store the **raw payload verbatim** in the event row and normalize into typed columns at write time with a tolerant parser. Raw-first means a field rename in a future Claude Code release degrades a column, never loses data.

## Bonus fields the architecture doc didn't know about (all useful)

- **`prompt_id`** on every tool event — groups actions by user turn. Use it as a second-level grouping in the timeline (session → turn → actions).
- **`Stop` payload includes `last_assistant_message`** — a free per-turn summary of what the agent said, without parsing the transcript.
- **`SessionStart.source`** ∈ `startup | resume | clear | compact` — distinguishes new vs. resumed sessions (dedupe session records on resume).
- **`SessionEnd.reason`** — clean session closure.
- Internal/harness tools (`ToolSearch`, `TaskCreate`, `Agent`, …) also fire hooks → the normalizer needs a **tool classification table** (file-op / shell / mcp / agent-control / harness-internal) so the timeline can de-noise by default.
- Docs list ~30 hook events total, including `StopFailure` (turn ended on API error) and `PermissionRequest` (fires on permission dialogs — records what the *user* was asked to approve; interactive mode only).

## Version floor (from changelog archaeology)

| Feature | Minimum version |
|---|---|
| `tool_use_id` in Pre/Post payloads | 2.0.43 |
| `http` hook type | ~2.1.84 |
| `duration_ms` on Post/Failure | 2.1.119 |
| `continueOnBlock`, `args` exec-form | 2.1.139 |

→ **`blackbox init` should run `claude --version` and require ≥ 2.1.119** (warn, degrade gracefully below).

## Operational facts for the daemon

- HTTP hook requests: `POST`, `content-type: application/json`, user-agent `axios/…`; body is exactly the same JSON a command hook gets on stdin. A `200` with any body suffices.
- **Hook `timeout` is in SECONDS** (default 600), not ms.
- **HTTP hooks are deduplicated by URL** across settings files — the installer writing into `~/.claude/settings.json` is naturally idempotent-friendly, but still merge, don't clobber.
- Hooks can be registered at user (`~/.claude/settings.json`), project (`.claude/settings.json`), and local (`.claude/settings.local.json`) scope, and they merge. Register blackbox at **user scope** to catch all projects.
- PreToolUse blocking (exit 2 / `permissionDecision: "deny"`) is confirmed to exist — the [LATER] enforcement rung has a platform mechanism waiting; deliberately unused in V1.

## Reproduce

```bash
cd experiments/day1-hooks
node http-receiver.mjs &                     # listens on 127.0.0.1:7842
mkdir -p /tmp/hooktest/.claude && cp settings.hooks-used.json /tmp/hooktest/.claude/settings.json
cd /tmp/hooktest && claude -p '...' --allowedTools "Bash,Write,Read" --mcp-config <(echo '{"mcpServers":{"hooktest":{"command":"node","args":["<abs path>/echo-server.mjs"]}}}')
```

Captured fixtures in `experiments/day1-hooks/fixtures/` are real, unedited hook payloads (one JSON object per line; `_captured_at` was appended by the capture hook itself, everything else is verbatim from Claude Code). Use them as the normalizer's first test corpus.
