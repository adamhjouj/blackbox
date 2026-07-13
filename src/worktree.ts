/**
 * R2 — git ground truth. At SessionEnd, diff the worktree against the session's
 * START HEAD anchor to capture what ACTUALLY changed on disk during the session:
 * per path {status, insertions, deletions, sha256 of current content}. This is the
 * captured FACT the reconciliation layer joins against the agent's self-reported
 * hook mutations (ghost / phantom / content_mismatch).
 *
 * LOW-LEAK BY DESIGN: only paths + counts + content HASHES are stored — never file
 * bodies — so no secret can leak through the delta. Fast, guarded git calls with a
 * timeout; failure returns null (the session is marked uncorroborated), never throws.
 * Runs off the hook path (the daemon schedules it after SessionEnd).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_SAFE_FLAGS } from './git-safe';
import { redactText } from './redact';

const MAX_FILES = 500; // cap the delta so a giant refactor can't bloat the fact
const MAX_HASH_BYTES = 4 * 1024 * 1024; // don't read huge single files just to hash them
const HASH_BUDGET = 96 * 1024 * 1024; // aggregate read budget across all files (event-loop safety)

export interface WorktreeFile {
  /** REPO-RELATIVE path (git's native form). Symlink-immune — the reconciler matches
   *  it as a suffix of the hook's absolute target, so a symlinked or high-entropy
   *  path prefix can't cause a false ghost/phantom. */
  path: string;
  /** 'A' added · 'M' modified · 'D' deleted · '?' untracked-new. */
  status: string;
  insertions: number;
  deletions: number;
  /** sha256 of the current on-disk BYTES; null when deleted / unreadable / oversize / special. */
  sha256: string | null;
}

export interface WorktreeDelta {
  base: string; // the session's start HEAD
  head: string | null; // HEAD at session end (may differ if the session committed)
  files: WorktreeFile[];
  truncated: boolean; // more than MAX_FILES changed
  hash_truncated: boolean; // the aggregate read budget was hit; some sha256 are null
}

/** Diff the worktree at `cwd` against `baseSha`. Returns null when it can't be
 *  computed (no cwd, not a repo, bad base) → the session is uncorroborated. */
export function captureWorktreeDelta(cwd: string | null, baseSha: string | null): WorktreeDelta | null {
  if (!cwd || !baseSha) return null;
  const at = (repo: string, args: string[]): string | null => {
    try {
      // core.quotePath=false keeps non-ASCII filenames verbatim (git otherwise C-quotes them);
      // GIT_SAFE_FLAGS neutralise a hostile repo's core.fsmonitor exec on index refresh.
      return execFileSync('git', ['-C', repo, ...GIT_SAFE_FLAGS, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  // Resolve the repo toplevel and run everything there, so git's paths are all
  // relative to the SAME root — then join to ABSOLUTE, matching the hook targets
  // (Claude Code tools pass absolute file_path). Mixing cwd-relative and
  // toplevel-relative paths was a real false-positive source.
  const top = at(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null; // not a repo
  const run = (args: string[]): string | null => at(top, args);
  const head = run(['rev-parse', 'HEAD']);
  if (head === null) return null;
  // Validate the base is a real object; if it's gone (shallow/gc), we can't corroborate.
  if (run(['cat-file', '-e', baseSha + '^{commit}']) === null) return null;

  const byPath = new Map<string, WorktreeFile>();

  // tracked changes since base (committed + staged + unstaged), with status + counts
  const nameStatus = run(['diff', '--name-status', baseSha, '--']);
  if (nameStatus) {
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const code = (parts[0] ?? '').charAt(0); // A/M/D/R/C...
      const path = parts[parts.length - 1] ?? ''; // rename → new path
      if (path) byPath.set(path, { path, status: code || 'M', insertions: 0, deletions: 0, sha256: null });
    }
  }
  const numstat = run(['diff', '--numstat', baseSha, '--']);
  if (numstat) {
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue;
      const [ins, del, ...rest] = line.split('\t');
      const path = rest[rest.length - 1] ?? '';
      const f = byPath.get(path);
      if (f) {
        f.insertions = ins === '-' ? 0 : Number(ins) || 0;
        f.deletions = del === '-' ? 0 : Number(del) || 0;
      }
    }
  }
  // untracked new files the agent created (not in git yet)
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  if (untracked) {
    for (const path of untracked.split('\n')) {
      if (path.trim() && !byPath.has(path)) byPath.set(path, { path, status: '?', insertions: 0, deletions: 0, sha256: null });
    }
  }

  const rel = [...byPath.values()];
  const truncated = rel.length > MAX_FILES;
  // For each file: hash the raw on-disk BYTES (faithful for text and binary), then
  // store the REPO-RELATIVE path (redacted; usually a no-op for normal paths).
  // Safety: lstat (never follow symlinks) + require a regular file (rejects a
  // symlink/FIFO/device that could hang or OOM the daemon), plus an aggregate byte
  // budget so a session of many large files can't block the event loop.
  let hashedBytes = 0;
  let hash_truncated = false;
  const files: WorktreeFile[] = rel.slice(0, MAX_FILES).map((f) => {
    let sha256: string | null = null;
    if (f.status !== 'D') {
      try {
        const abs = join(top, f.path);
        const st = lstatSync(abs);
        if (st.isFile() && st.size <= MAX_HASH_BYTES) {
          if (hashedBytes + st.size > HASH_BUDGET) hash_truncated = true;
          else {
            const buf = readFileSync(abs);
            hashedBytes += buf.length;
            sha256 = 'sha256:' + createHash('sha256').update(buf).digest('hex');
          }
        }
      } catch {
        /* unreadable / special file → sha256 stays null */
      }
    }
    return { ...f, path: redactText(f.path).text, sha256 };
  });

  return { base: baseSha, head, files, truncated, hash_truncated };
}
