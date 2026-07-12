# Phase 8 (R2) — Git-anchored reconciliation ("the agent can't lie")

The hook stream is the agent's *self-report*. R2 independently checks it against **git ground truth**: at SessionEnd, diff the worktree vs the session's start HEAD and reconcile that against the file-write/edit mutations the hooks recorded. Deterministic, unprivileged, near-zero false positives. **No OS collectors** — the earlier fs.watch/lsof/ppid design was cut (it can't attribute, and a 1 s poll can't see a sub-second exfil, so it would cry wolf exactly where the product must be believed).

## The load-bearing rule (unchanged)
The **worktree delta** (paths + status + diffstat + on-disk content **hashes** — never bodies) is a **captured fact** → hashed `detail.worktree_delta` on a new appended event. The **ghost/phantom/mismatch findings + coverage** are **interpretation** → the un-hashed `session_reconciliation` table, ruleset-keyed, recomputable via `blackbox reconcile`. `verify()` is byte-identical. Low-leak by design: only hashes + relative paths.

## The three discrepancies
- **`ghost_mutation`** (the money finding) — a file changed on disk with **no** file-write/edit hook covering it. Reported **unattributed** (a shell command, a human, or another tool) — never asserted to be the agent.
- **`phantom_mutation`** — a hook recorded a change with **no** net on-disk effect (reverted/overwritten).
- **`content_mismatch`** — an unredacted, stored **body write** whose on-disk content differs from what the hook recorded (a post-write modifier, e.g. a formatter).

## Getting the acceptance bar right (a clean hook-only session = ZERO findings)
Adversarial review caught two false-positive breakers on the *simplest* clean session; both are fixed and tested:
- **Symlinked paths (was CRITICAL).** git resolves the repo root (`/private/var/…`); Claude Code's `file_path` keeps the symlinked prefix (`/var/…`). Exact-string joins fired ghost **and** phantom on every clean edit under `/tmp`, `/var`, or any symlinked checkout. **Fix:** delta paths are stored **repo-relative** and matched as a **suffix** of the hook's absolute target — symlink- and prefix-immune.
- **Dirty worktree at start (was HIGH).** The base is HEAD, so a developer's pre-existing uncommitted edits and untracked files were blamed on the agent. **Fix:** at SessionStart we snapshot the dirty/untracked **baseline** (`detail.worktree_base`); reconciliation only surfaces a ghost for a path whose content actually **changed** during the session.

## Robustness (hardened after review)
`captureWorktreeDelta` (`src/worktree.ts`): a 2 s git timeout and degrade-to-null (never throws); **`lstat` + regular-file-only** reads (a symlink/FIFO/`/dev/zero` in the tree can't hang or OOM the daemon); an **aggregate byte budget** so many large files can't block the event loop; **raw-byte** hashing (faithful for binary); `core.quotePath=false` for non-ASCII names; `MAX_FILES` cap with a `truncated` flag that **suppresses phantoms** (an absent path might be in the dropped tail) and surfaces in coverage. All capture/reconcile runs **async, off the hook path**, deduped per session.

## Coverage / self-blindness (first-class)
A tool that silently misses data is worse than none. `coverage` records `corroborated` + the honest `reason` (no git anchor / not-a-repo) + `truncated`. The UI renders a **coverage strip** on the session story: `✓ git-corroborated`, `⚠ N discrepancies`, or `uncorroborated — <reason>`.

## Honest scope (README + UI)
*"blackbox corroborates file mutations against git ground truth. It does not observe network or process activity."* Shell-command file changes can't be attributed (no OS collectors) → reported unattributed. A minor race: an edit within ~300 ms of SessionStart may be folded into the baseline. Network/process visibility is a deferred, opt-in Tier-2 capability — never a poll pretending to do the job.

## Files
`src/worktree.ts` (new) · `src/reconcile.ts` (new: pure `reconcile` + `reconcileSession`/`persistReconciliation`) · `src/normalize.ts` (`worktreeDeltaEvent`/`worktreeBaseEvent`) · `src/store.ts` (`session_reconciliation` + CRUD, `sessionBaseSha`, `worktree{Delta,Base}Exists`) · `src/daemon.ts` (SessionStart baseline + SessionEnd capture/reconcile) · `src/cli.ts` (`reconcile [--session] [--check]`) · `src/read-api.ts` + `src/ui-page.ts` (coverage strip) · `test/reconcile.test.js` (15).

## Verification
15 tests: the acceptance bar (ZERO on a clean session), **suffix/symlink immunity**, all three discrepancies, redacted/skipped/edit suppression of content_mismatch, **dirty-baseline** suppression, truncation → no-phantom + coverage, `reconcileSession` integration (chain byte-identical, rescore idempotent), `sessionBaseSha`, and real-git capture (modify + untracked + rename). Full suite **194 pass**. Adversarially verified (false-positive hunt / boundary / leak / test-gaps) — the symlink, dirty-worktree, FIFO-hang, and binary-hash issues it found are fixed. Live: an isolated daemon over HTTP catches a ghost while a hook-written file stays clean.
