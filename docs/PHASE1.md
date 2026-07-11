# Phase 1 — Live capture: daemon + redaction + git forensics (built)

Phase 0 was the store. Phase 1 makes blackbox actually record real Claude Code sessions automatically, with secrets redacted, plus a git ground-truth collector — all landing in the same hash-chained store `verify` already covers.

## Quick start

```bash
npm install && npm run build
node dist/cli.js init                 # register hooks in ~/.claude/settings.json (idempotent)
node dist/cli.js start                # daemon on 127.0.0.1:7842
node dist/cli.js watch ~/code/myrepo  # optional: git ground-truth for a repo
# ... use Claude Code normally ...
node dist/cli.js list                 # the timeline
node dist/cli.js verify               # chain intact?
node dist/cli.js audit                # what was redacted (type + path, never the secret)
node dist/cli.js status               # daemon health
```

## What each piece does

| Component | File | Role |
|---|---|---|
| **Daemon** | `daemon.ts` | `node:http` bound to `127.0.0.1` only. `POST /hook` normalizes+redacts+appends synchronously (single writer, no queue → durably chained the instant it returns 200). `POST /git` enriches ref changes. `GET /health`. Never crashes on bad input — always 200 after logging. |
| **Redaction** | `redact.ts`, `redact-rules.ts` | Fail-closed secret removal BEFORE the first write. Prefix rules (openai/anthropic/github/aws/slack/…/PEM) + conservative entropy + sensitive-path content drop. Walks only `tool_input`/`tool_response`/`error`/`last_assistant_message`. `raw` stores the redacted payload; output elided to `output_hash`. |
| **Git collector** | `git-collector.ts`, `watch.ts` | `reference-transaction`+`pre-push` hooks POST ref deltas to `/git`. Daemon classifies (commit/amend/reset/force/create/delete via ancestry), computes diffstat, and correlates back to the session + exact `tool_use_id`. |
| **Install** | `init.ts` | `init`/`uninit` merge/remove the http hooks in `~/.claude/settings.json` (idempotent, never clobber). `watch`/`unwatch` install git hooks per-repo (or `--global`). |
| **Lifecycle** | `cli.ts` | `start`/`stop`/`status` with a pid file + log in `~/.blackbox/`. |

## Verified end-to-end
A real `claude` session doing **write → commit → delete → curl** produces a single merged, chained timeline: Claude tool events interleaved with an enriched `git_action` row (real SHAs, diffstat, `reset --hard` flagged `force+reset`, correlated to the session). Secrets in commands / `.env` writes / tool output are provably absent from the DB. Malformed requests never crash the daemon. `verify` stays intact throughout.

## Honest limitations (documented, not hidden)
- **Completeness ≠ integrity.** Hooks are `async` and don't retry; if the daemon is down when an event fires, that event is silently lost and the hash chain cannot detect a *missing* event (a dropped hook isn't tampering). `blackbox status` tells you the daemon is up. A durable spool + daemon auto-start are follow-ups (see below).
- **Spool deferred.** The planned command-type spool hook would write the raw hook payload to disk *before* the daemon can redact it — plaintext secrets in the spool, contradicting the redaction guarantee. It needs a redacting spooler; until then capture is HTTP-only.
- **Local trust.** `/hook` and `/git` bind `127.0.0.1`; any local process could forge an event. A per-install token (in `~/.blackbox/config.json`) guards `/git`. Same model as the whole Tier-1 design.
- **Correlation can be ambiguous.** Two sessions in the same repo at once → recorded as `confidence: ambiguous` with candidate session ids, never a fabricated single attribution.
- **`raw` is redacted, not verbatim** — deliberate. Output bodies are hashes by default (`--capture-output` keeps them, still secret-scrubbed).
- **Redaction is best-effort on unknown formats.** Coverage: known-prefix rules, credential-keyword assignments (`KEY=value`, catches low-entropy secrets like `hunter2`), sensitive-path content drop (across Write/Edit/MultiEdit/NotebookEdit), and a two-pass entropy net (path-safe + a slash-aware pass for base64 secrets like AWS keys, guarded against real paths). A truly context-free, low-entropy, novel-format secret in a non-sensitive file can still slip; the corpus is tunable.

## Security hardening (adversarial review applied)
An adversarial multi-agent review of the Phase 1 code found and this build fixes: AWS/base64-with-slash secret leakage and sensitive-file *edit* bypasses (redaction); browser-CSRF forging events (now: `/hook` rejects any request with an `Origin`/cross-site `Sec-Fetch-Site` or non-JSON content-type, so a website cannot POST to the localhost daemon); git argument-injection via forged ref SHAs (now: `old`/`new` are validated as hex object names before reaching `git`); request-path DoS (connection/timeout caps, delta cap, `readBody` settles on abort); and PID-recycling safety on `stop`/`start` (identity-checked via `/health`). Correlation now records `ambiguous` as candidates-only, never a fabricated `session_id`.

## Next
Phase 2 (timeline UI), Phase 3 (risk rules over this event stream), Phase 4 (report export). Durable spool + launchd auto-start are hardening follow-ups.
