import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { NormalizedEvent } from './types';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZERO = /^0+$/;

/** Run a git command in a repo; throws on non-zero (callers guard). */
function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
function gitOk(repo: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface RefDelta {
  ref: string;
  old: string;
  new: string;
}

export interface GitClass {
  kind: 'create' | 'delete' | 'commit' | 'amend' | 'reset' | 'force';
  is_force: boolean;
  is_delete: boolean;
  is_reset: boolean;
  is_amend: boolean;
}

/** Classify a ref update using ancestry — the ground-truth signal git can't fake. */
export function classify(repo: string, d: RefDelta): GitClass {
  if (ZERO.test(d.new)) return { kind: 'delete', is_force: false, is_delete: true, is_reset: false, is_amend: false };
  if (ZERO.test(d.old)) return { kind: 'create', is_force: false, is_delete: false, is_reset: false, is_amend: false };
  if (gitOk(repo, ['merge-base', '--is-ancestor', d.old, d.new]))
    return { kind: 'commit', is_force: false, is_delete: false, is_reset: false, is_amend: false }; // fast-forward
  // non-fast-forward: force. Sub-classify.
  const rewind = gitOk(repo, ['merge-base', '--is-ancestor', d.new, d.old]);
  let amend = false;
  try {
    // amend = old and new are both single-parent commits sharing the same parent
    // (a sibling rewrite), not merely equal first-parents.
    const op = git(repo, ['rev-list', '--parents', '-n', '1', d.old]).split(/\s+/).slice(1);
    const np = git(repo, ['rev-list', '--parents', '-n', '1', d.new]).split(/\s+/).slice(1);
    amend = op.length === 1 && np.length === 1 && op[0] === np[0];
  } catch {
    /* root commit or missing object */
  }
  return {
    kind: rewind ? 'reset' : amend ? 'amend' : 'force',
    is_force: true,
    is_delete: false,
    is_reset: rewind,
    is_amend: amend,
  };
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}
export function diffstat(repo: string, d: RefDelta): DiffStat | null {
  if (ZERO.test(d.new)) return null;
  try {
    const base = ZERO.test(d.old) ? EMPTY_TREE : d.old;
    const out = git(repo, ['diff-tree', '--no-commit-id', '--numstat', '-r', base, d.new]);
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [a, b] = line.split('\t');
      files++;
      insertions += Number(a) || 0; // '-' for binary files → NaN → 0
      deletions += Number(b) || 0;
    }
    return { files, insertions, deletions };
  } catch {
    return null;
  }
}

export interface CommitMeta {
  sha: string;
  author: string;
  subject: string;
  ts: number;
}
export function commitMeta(repo: string, sha: string): CommitMeta | null {
  try {
    const out = git(repo, ['show', '-s', '--format=%H%n%an%n%ct%n%s', sha]);
    const [h = '', an = '', ct = '0', ...sub] = out.split('\n');
    return { sha: h, author: an, ts: Number(ct) || 0, subject: sub.join('\n') };
  } catch {
    return null;
  }
}

export function resolveRepoTop(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

// ---- session correlation -------------------------------------------------

export type Confidence = 'exact' | 'session' | 'ambiguous' | 'none';
export interface Correlation {
  confidence: Confidence;
  session_id: string;
  tool_use_id: string | null;
  candidates: string[];
}

interface SessionState {
  cwd: string | null;
  repoTop: string | null;
  lastSeenAt: number;
}
interface GitBashCall {
  session_id: string;
  tool_use_id: string | null;
  repoTop: string | null;
  command: string;
  t: number;
}

/** Does a Bash git command look like it would produce this ref change? Verbs must
 *  appear as a git subcommand (after `git`, before any quote) to avoid matching a
 *  word inside a commit message like `git commit -m "reset the counter"`. */
function shapeConsistent(command: string, cls: GitClass): boolean {
  const verb = (v: string): boolean => new RegExp(`\\bgit\\b[^"']*\\b${v}\\b`).test(command);
  if (cls.is_delete) return /\bgit\b[^"']*\b(branch|tag)\b[^"']*-[dD]\b/.test(command) || /\bgit\b[^"']*\bpush\b[^"']*(--delete|:\S)/.test(command);
  if (cls.is_reset) return verb('reset') || verb('rebase');
  if (cls.is_force) return /\bgit\b[^"']*\bpush\b[^"']*(--force|-f)\b/.test(command) || verb('rebase') || /\bgit\b[^"']*\bcommit\b[^"']*--amend/.test(command) || verb('reset');
  if (cls.kind === 'create') return verb('checkout') || verb('switch') || verb('branch') || verb('tag') || verb('commit') || verb('merge');
  return verb('commit') || verb('merge') || verb('pull') || verb('cherry-pick') || verb('revert');
}

/**
 * Correlates git ref changes back to the Claude session (and ideally the exact
 * `git` Bash call) that caused them, using the daemon's live view of the hook
 * stream. Best-effort and honest: concurrent sessions in one repo yield
 * `ambiguous` with candidates, never a fabricated single attribution.
 */
export class Correlator {
  private sessions = new Map<string, SessionState>();
  private bashCalls: GitBashCall[] = [];
  private topCache = new Map<string, string | null>();
  private readonly windowMs = 15_000;

  private repoTop(cwd: string | null): string | null {
    if (!cwd) return null;
    if (this.topCache.has(cwd)) return this.topCache.get(cwd) ?? null;
    const top = resolveRepoTop(cwd);
    this.topCache.set(cwd, top);
    return top;
  }

  /** Feed every Claude hook event so we know each session's repo + recent git calls. */
  observe(payload: Record<string, unknown>, now: number): void {
    const sid = typeof payload.session_id === 'string' ? payload.session_id : null;
    if (!sid) return;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
    const top = this.repoTop(cwd);
    this.sessions.set(sid, { cwd, repoTop: top, lastSeenAt: now });

    const input = payload.tool_input as Record<string, unknown> | undefined;
    const command = input && typeof input.command === 'string' ? input.command : null;
    if (payload.tool_name === 'Bash' && command && /\bgit\b/.test(command)) {
      this.bashCalls.push({
        session_id: sid,
        tool_use_id: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null,
        repoTop: top,
        command,
        t: now,
      });
      if (this.bashCalls.length > 200) this.bashCalls.shift();
    }
  }

  correlate(repoTop: string | null, cls: GitClass, now: number): Correlation {
    if (!repoTop) return { confidence: 'none', session_id: 'unknown', tool_use_id: null, candidates: [] };
    const candidates = [...this.sessions.entries()]
      .filter(([, s]) => s.repoTop === repoTop && now - s.lastSeenAt < this.windowMs)
      .map(([id]) => id);

    const consistent = this.bashCalls.filter(
      (b) => b.repoTop === repoTop && now - b.t < this.windowMs && shapeConsistent(b.command, cls),
    );
    if (consistent.length === 1) {
      const c = consistent[0]!;
      return { confidence: 'exact', session_id: c.session_id, tool_use_id: c.tool_use_id, candidates };
    }
    if (candidates.length === 1) return { confidence: 'session', session_id: candidates[0]!, tool_use_id: null, candidates };
    // Multiple sessions active in the same repo → do NOT fabricate a single
    // attribution; record all candidates and leave session_id unknown.
    if (candidates.length > 1)
      return { confidence: 'ambiguous', session_id: 'unknown', tool_use_id: null, candidates };
    return { confidence: 'none', session_id: 'unknown', tool_use_id: null, candidates: [] };
  }
}

// ---- event construction --------------------------------------------------

const short = (sha: string) => (ZERO.test(sha) ? '∅' : sha.slice(0, 7));

export function normalizeGit(params: {
  repoTop: string;
  delta: RefDelta;
  cls: GitClass;
  diff: DiffStat | null;
  commit: CommitMeta | null;
  correlation: Correlation;
  rawBody: string;
  capturedAt: string;
}): NormalizedEvent {
  const { repoTop, delta, cls, diff, commit, correlation, rawBody, capturedAt } = params;
  const diffPart = diff ? ` (+${diff.insertions} −${diff.deletions}, ${diff.files} file${diff.files === 1 ? '' : 's'})` : '';
  const target = `${cls.kind} ${delta.ref} ${short(delta.old)}→${short(delta.new)}${diffPart}`;

  const detail = {
    git: {
      ref: delta.ref,
      old_sha: delta.old,
      new_sha: delta.new,
      kind: cls.kind,
      is_force: cls.is_force,
      is_reset: cls.is_reset,
      is_delete: cls.is_delete,
      is_amend: cls.is_amend,
      diffstat: diff,
      commit,
    },
    correlation,
  };

  return {
    event_id: randomUUID(),
    session_id: correlation.session_id,
    tool_use_id: correlation.tool_use_id,
    prompt_id: null,
    phase: 'post',
    hook_event: 'GitRefTransaction',
    tool_name: 'git',
    action_type: 'git_action',
    target,
    agent_id: null,
    agent_type: 'main',
    cwd: repoTop,
    permission_mode: null,
    success: 1,
    duration_ms: null,
    ts: capturedAt,
    captured_at: capturedAt,
    // git refs/SHAs are not secrets; store the posted body verbatim.
    raw: JSON.stringify({ kind: 'git-ref-transaction', repo: repoTop, body: rawBody }),
    output_hash: null,
    output_size_bytes: null,
    redaction_count: 0,
    detail: JSON.stringify(detail),
  };
}

const SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_DELTAS = 100;

/** Parse "old new ref" lines and drop synthetic/noise refs. Validates that old/new
 *  are real object names — a non-SHA value could otherwise inject arguments into the
 *  `git` plumbing calls (e.g. `--output=…`). Caps the batch to bound request work. */
export function parseRefLines(body: string): RefDelta[] {
  const out: RefDelta[] = [];
  for (const line of body.split('\n')) {
    if (out.length >= MAX_DELTAS) break;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [old, nw, ...rest] = parts;
    if (!SHA_RE.test(old!) || !SHA_RE.test(nw!)) continue; // reject non-SHA → blocks arg injection
    const ref = rest.join(' ');
    if (/^(AUTO_MERGE|ORIG_HEAD)$/.test(ref) || ref.startsWith('refs/stash')) continue;
    if (ZERO.test(old!) && ZERO.test(nw!)) continue;
    out.push({ old: old!, new: nw!, ref });
  }
  return out;
}
