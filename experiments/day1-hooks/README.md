# day1-hooks — the Section 2.3 hook-reality test (executed 2026-07-11)

Proof that Claude Code hooks deliver everything the blackbox collector needs, run against Claude Code **2.1.206**. Conclusions in [`../../docs/DAY1-FINDINGS.md`](../../docs/DAY1-FINDINGS.md).

## Contents

| File | What it is |
|---|---|
| `settings.hooks-used.json` | The project-scope `.claude/settings.json` used in run 2 — command hooks (capture to JSONL via `jq`) **plus** `type: "http"` hooks with `async: true` pointing at `127.0.0.1:7842` |
| `http-receiver.mjs` | Minimal daemon stand-in: logs every POST (headers + body) as one JSON line. This is the seed of the real collector. |
| `echo-server.mjs` | Dependency-free stdio MCP server (newline-delimited JSON-RPC, one `echo` tool) used to generate a real MCP tool call. Reusable as a test fixture for the whole project. |
| `fixtures/events-run1-basics.jsonl` | Run 1 via command hooks: SessionStart → Bash → Write → Read → **failed Read (PostToolUseFailure)** → MCP call → Stop → SessionEnd. 15 events, unedited. |
| `fixtures/events-run2-subagent.jsonl` | Run 2: Bash + Task-spawned subagent. Shows `agent_id`/`agent_type` attribution and `SubagentStart`/`SubagentStop`. |
| `fixtures/http-delivered-events.jsonl` | The same run-2 events as received over **HTTP** by `http-receiver.mjs` — proving `type: "http"` + `async: true` delivery works. Body is byte-identical to the command-hook stdin payload. |

`_captured_at` in the command-hook fixtures was appended by the capture command itself (`jq '. + {_captured_at: ...}'`); every other field is verbatim from Claude Code.

## Reproduce

```bash
# 1. start the receiver
node http-receiver.mjs &

# 2. make a scratch project with the hooks registered
mkdir -p /tmp/hooktest/.claude
cp settings.hooks-used.json /tmp/hooktest/.claude/settings.json   # fix absolute paths inside first

# 3. run a headless session that exercises bash/write/read/failure/MCP
cd /tmp/hooktest
claude -p 'Run `echo hi`; write note.txt; read it; read /nonexistent/x.txt (expect failure, do not retry); call the echo tool from the hooktest MCP server with message hi-mcp; then say DONE.' \
  --allowedTools "Bash,Write,Read,mcp__hooktest__echo" \
  --mcp-config '{"mcpServers":{"hooktest":{"command":"node","args":["/abs/path/to/echo-server.mjs"]}}}'
```
