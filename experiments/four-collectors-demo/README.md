# four-collectors-demo — what actually gets recorded (executed 2026-07-11)

A real end-to-end run proving what the V1 collector stack captures. An agent (Claude Code 2.1.206, headless) was driven through: **write a file → git commit it → delete it → curl a URL**. Four collectors ran simultaneously; `captured/` holds their unedited output.

## The collectors

| # | Collector | Mechanism | Perms | Ground truth it adds |
|---|---|---|---|---|
| 1 | **Claude hooks** | `PreToolUse`/`PostToolUse`/`PostToolUseFailure` command hooks → `captured/hook-events.jsonl` | none | Intent + result at the tool boundary: full args, full response, timing, `tool_use_id` |
| 2 | **git** | `.git/hooks/reference-transaction` → `captured/collector-events.jsonl` | none | Every ref mutation with old→new SHA (commit/amend/reset/branch) |
| 3 | **network** | `net-poller.mjs`: `lsof -i` over the agent process tree, ~120ms poll | none (same-uid) | Real resolved IP:port the agent connected to |
| 4 | **process** | same poller: `ps` ppid-tree walk from the Claude PID | none | The exec chain — which process spawned the connection |

## What the run captured (see `captured/`)

- **Write** → hook recorded `file_path` + the **entire file content** the agent wrote.
- **commit** → git collector recorded `refs/heads/main 0000000 -> e20f129`; process collector saw `git commit` exec (pid 1257) and the hook firing. **Key forensic point:** `notes.txt` was later deleted from the working tree but still lives in commit `e20f129` — the record makes that recoverability explicit.
- **rm** → hook recorded the command + a clean (empty stdout) result in 27ms.
- **curl** → the agent's **first attempt failed** (zsh globbed the unquoted `?` in the URL) and was captured as `PostToolUseFailure`; the retry succeeded (HTTP 200). Network collector caught the real flow `192.0.2.10:63997 -> 162.159.140.220:443 (ESTABLISHED)` (a Cloudflare IP); process collector attributed it: `curl` (pid 1417) ← `zsh` (1414) ← the Claude node process (220).

The merged, time-sorted view of all four is the timeline the UI renders. Regenerate it and the demo with the commands in this repo (`net-poller.mjs` + the settings/hook files).

## Honest limits shown by this same run

- **Network is poll-based.** The 3MB Cloudflare download stayed connected ~0.5s so the 120ms poller caught it; a sub-100ms connection can slip between polls. The *command string* (with the URL) is always caught by the hook regardless — the poller adds the confirmed resolved IP, not the only evidence.
- **No packet contents.** We record that curl connected to `162.159.140.220:443`, not the bytes sent (TLS anyway). "Data left the machine" must be phrased as "an outbound connection/transfer-shaped command ran to X."
- **Attribution via ppid tree works** for normal spawns; a process that re-parents to `launchd` would break the chain — that's the case that needs Endpoint Security (root), the Tier-2 collector.
