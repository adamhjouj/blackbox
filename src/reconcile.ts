/**
 * R2 — reconciliation. A PURE, re-derivable join of git ground truth (the captured
 * `worktree_delta` fact) against the agent's self-reported hook mutations. It never
 * touches the chain — findings live in the un-hashed `reconciliation` table, keyed by
 * ruleset, recomputable via `rescore`. Same discipline as the risk layer.
 *
 * Acceptance bar: a clean hook-only session (every on-disk change came from a
 * file-write/edit hook, and the writes stuck) yields ZERO findings.
 *
 * Honest limit: we can't attribute a shell command (`rm`, `mv`, `>`) to a path
 * without OS-level collectors, so a "ghost" is reported as UNATTRIBUTED — never
 * asserted to be the agent, and never asserted to be a human.
 */
import type { Store } from './store';
import type { WorktreeDelta } from './worktree';

/** Reconciliation ruleset version (keyed like risk, so it stays reproducible). */
export const RECON_VERSION = 'v1';

function safeParse(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type DiscrepancyType = 'ghost_mutation' | 'phantom_mutation' | 'content_mismatch';

export interface Discrepancy {
  type: DiscrepancyType;
  path: string;
  note: string;
  /** The hook mutation's event seq, when the finding involves one. */
  seq?: number;
}

/** One file the agent claims (via a file_write/file_edit hook) it changed. */
export interface HookMutation {
  path: string;
  kind: 'patch' | 'body';
  content_hash: string | null;
  redacted: boolean;
  stored: boolean;
  seq: number;
}

export interface Coverage {
  corroborated: boolean;
  reason: string | null; // why not corroborated (no anchor / not-a-repo / …)
  files_on_disk: number;
  hook_files: number;
  truncated: boolean; // the delta hit the file cap — phantom detection is suppressed
}

export interface Reconciliation {
  findings: Discrepancy[];
  coverage: Coverage;
}

function statusWord(s: string): string {
  return s === 'A' ? 'added' : s === 'D' ? 'deleted' : s === '?' ? 'created (untracked)' : 'modified';
}

export interface ReconcileOptions {
  anchorReason?: string | null;
  /** Files already dirty/untracked at SessionStart → their start-of-session sha256.
   *  A pre-existing file that didn't change during the session is not the agent's
   *  doing, so it must not be reported as a ghost. */
  baseline?: Map<string, string | null> | null;
}

/** A repo-relative delta path matches a hook's absolute target iff the target ends
 *  with it — symlink- and prefix-immune (git resolves the repo root; hooks don't). */
function targetCovers(hookTarget: string, relPath: string): boolean {
  return hookTarget === relPath || hookTarget.endsWith('/' + relPath);
}

/**
 * Join the ground-truth delta against the hook mutations. `delta === null` means the
 * session couldn't be anchored (untracked / no repo) → uncorroborated, no findings.
 */
export function reconcile(delta: WorktreeDelta | null, mutations: HookMutation[], opts: ReconcileOptions = {}): Reconciliation {
  const hookTargets = mutations.map((m) => m.path);
  const coverage: Coverage = {
    corroborated: !!delta,
    reason: delta ? null : opts.anchorReason ?? 'no-git-anchor',
    files_on_disk: delta?.files.length ?? 0,
    hook_files: new Set(hookTargets).size,
    truncated: !!delta?.truncated,
  };
  if (!delta) return { findings: [], coverage };

  const findings: Discrepancy[] = [];
  const baseline = opts.baseline;

  // ghost_mutation — the money finding: an on-disk change with NO file-write/edit
  // hook that covers it, AND that actually changed during the session (a pre-existing
  // dirty file that didn't change since SessionStart is not the agent's doing).
  for (const f of delta.files) {
    if (hookTargets.some((t) => targetCovers(t, f.path))) continue;
    if (baseline && baseline.has(f.path) && baseline.get(f.path) === f.sha256) continue; // pre-existing, unchanged
    findings.push({ type: 'ghost_mutation', path: f.path, note: `${statusWord(f.status)} on disk with no file-write/edit hook — unattributed (a shell command, a human, or another tool)` });
  }

  // per-hook-path: the LAST mutation is what the agent believes the file should be.
  const lastByTarget = new Map<string, HookMutation>();
  for (const m of mutations) {
    const prev = lastByTarget.get(m.path);
    if (!prev || m.seq > prev.seq) lastByTarget.set(m.path, m);
  }
  for (const [target, m] of lastByTarget) {
    const f = delta.files.find((df) => targetCovers(target, df.path));
    if (!f) {
      // A truncated delta dropped files past the cap, so an absent path might just be
      // in the tail — don't cry phantom. (ghost/mismatch stay sound: those paths ARE
      // in the delta.)
      if (!delta.truncated) {
        findings.push({ type: 'phantom_mutation', path: target, seq: m.seq, note: 'a file-write/edit hook recorded a change, but the net on-disk state shows none (reverted or overwritten)' });
      }
      continue;
    }
    // content_mismatch — only when we can compare precisely: the last write was a
    // FULL, UNREDACTED, STORED body (so its hash equals a raw on-disk hash) yet disk
    // differs. (Redacted / skipped writes and edit-patches can't be compared.)
    if (m.kind === 'body' && m.stored && !m.redacted && m.content_hash && f.sha256 && m.content_hash !== f.sha256) {
      findings.push({ type: 'content_mismatch', path: f.path, seq: m.seq, note: 'the file on disk differs from the content the hook recorded — modified after the write (e.g. a formatter or a non-hook actor)' });
    }
  }

  return { findings, coverage };
}

/**
 * Driver: gather the session's captured worktree_delta fact + its hook mutations
 * from the store and reconcile them. Pure read of immutable events — no writes.
 */
export function reconcileSession(store: Store, sessionId: string): Reconciliation {
  let delta: WorktreeDelta | null = null;
  let baseline: Map<string, string | null> | null = null;
  let anchorReason: string | null = null;
  const mutations: HookMutation[] = [];
  for (const e of store.eventsLight(sessionId)) {
    const d = safeParse(e.detail);
    if (!d) continue;
    if (d.worktree_delta) delta = d.worktree_delta as WorktreeDelta; // end-of-session ground truth
    if (d.worktree_base) {
      // files already dirty/untracked at SessionStart → don't blame the agent for them
      const b = d.worktree_base as WorktreeDelta;
      baseline = new Map((b.files ?? []).map((f) => [f.path, f.sha256 ?? null]));
    }
    const anchor = d.anchor as { reason?: string } | undefined;
    if (anchor?.reason && !anchorReason) anchorReason = anchor.reason;
    const m = d.mutation as { kind?: string; content_hash?: string; redacted?: boolean; stored?: boolean } | undefined;
    if (m && e.target) {
      mutations.push({ path: e.target, kind: m.kind === 'body' ? 'body' : 'patch', content_hash: m.content_hash ?? null, redacted: !!m.redacted, stored: m.stored !== false, seq: e.seq });
    }
  }
  return reconcile(delta, mutations, { anchorReason, baseline });
}

/** Compute + persist a session's reconciliation into the un-hashed layer. */
export function persistReconciliation(store: Store, sessionId: string, nowIso: string): Reconciliation {
  const r = reconcileSession(store, sessionId);
  const events = store.eventsLight(sessionId);
  const last_seq = events.length ? events[events.length - 1]!.seq : 0;
  store.reconciliationUpsert({
    session_id: sessionId,
    ruleset_version: RECON_VERSION,
    corroborated: r.coverage.corroborated ? 1 : 0,
    finding_count: r.findings.length,
    findings: JSON.stringify(r.findings),
    coverage: JSON.stringify(r.coverage),
    last_seq,
    computed_at: nowIso,
  });
  return r;
}
