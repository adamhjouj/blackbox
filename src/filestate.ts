/**
 * R7.2 — file history. A pure read-time projection (never writes, never touches
 * the chain) that answers "what did the agent do to THIS file, in order?" from
 * the immutable mutation facts already captured: each file_write/file_edit rides
 * a `detail.mutation` fact (kind, content_hash, diffstat, redacted) whose bytes
 * live in the content-addressed `blobs` table.
 *
 * This is the zero-fabrication half of R7.2 — every entry is a recorded fact with
 * its stored patch/body. Full point-in-time RECONSTRUCTION (replaying patches to
 * rebuild the file at an arbitrary seq) is deferred: it needs a confidence-machine
 * (dirty-base detection, multi-match stops, ghost-mutation demotion, end-hash
 * validation) so it can never present a file state that never existed on disk.
 */
import { createHash } from 'node:crypto';
import type { DiffStat, MutationFact } from './mutation';
import type { Store } from './store';
import type { BlackboxEvent } from './types';

export interface FileMutationRecord {
  seq: number;
  ts: string;
  /** file_write | file_edit */
  action: string;
  tool: string | null;
  kind: 'patch' | 'body';
  diffstat: DiffStat;
  content_hash: string;
  /** true when the blob bytes are persisted (false = oversize/binary/pruned). */
  stored: boolean;
  /** true when a secret was scrubbed from this mutation's content. */
  redacted: boolean;
  skip_reason?: string;
  /** the stored patch hunk or full body (already redacted), or null when unavailable. */
  content: string | null;
}

export interface FileHistory {
  path: string;
  session_id: string;
  /** the session's start HEAD (git base), if the session was anchored. */
  base_sha: string | null;
  /** the R2 end-of-session on-disk sha256 for this path, if a worktree delta exists. */
  end_sha256: string | null;
  mutations: FileMutationRecord[];
}

/** A CLI/query path matches a stored (absolute, possibly 500-cp-truncated) target
 *  iff they're equal or either is a path-suffix of the other — so a user can pass
 *  a repo-relative tail or the full path. */
function pathMatches(target: string, query: string): boolean {
  return target === query || target.endsWith('/' + query) || query.endsWith('/' + target);
}

function asFact(detail: string | null): MutationFact | null {
  if (!detail) return null;
  try {
    const m = (JSON.parse(detail) as { mutation?: unknown }).mutation;
    return m && typeof m === 'object' ? (m as MutationFact) : null;
  } catch {
    return null;
  }
}

/** The end-of-session on-disk sha256 for a path, from the R2 worktree delta fact. */
function endSha(store: Store, sessionId: string, query: string): string | null {
  for (const e of store.eventsLight(sessionId)) {
    if (e.hook_event !== 'WorktreeDelta' || !e.detail) continue;
    try {
      const files = (JSON.parse(e.detail) as { worktree_delta?: { files?: { path: string; sha256: string | null }[] } }).worktree_delta?.files ?? [];
      const hit = files.find((f) => pathMatches(query, f.path) || pathMatches(f.path, query));
      if (hit) return hit.sha256;
    } catch {
      /* tolerate a malformed delta */
    }
  }
  return null;
}

/**
 * The ordered mutation history for a file within a session. Mutation facts ride on
 * the POST event of a file_write/file_edit; we read the light columns (+ detail)
 * and hydrate each with its stored blob content.
 */
export function fileHistory(store: Store, sessionId: string, query: string): FileHistory {
  const mutations: FileMutationRecord[] = [];
  for (const e of store.eventsLight(sessionId) as BlackboxEvent[]) {
    if (e.action_type !== 'file_write' && e.action_type !== 'file_edit') continue;
    if (e.phase !== 'post') continue; // the fact lives on POST
    if (!e.target || !pathMatches(e.target, query)) continue;
    const fact = asFact(e.detail);
    if (!fact) continue;
    const blob = fact.stored ? store.blobGet(fact.content_hash) : null;
    mutations.push({
      seq: e.seq,
      ts: e.ts,
      action: e.action_type,
      tool: e.tool_name,
      kind: fact.kind,
      diffstat: fact.diffstat,
      content_hash: fact.content_hash,
      stored: fact.stored,
      redacted: !!fact.redacted,
      skip_reason: fact.skip_reason,
      content: blob ? blob.content : null,
    });
  }
  mutations.sort((a, b) => a.seq - b.seq);
  return {
    path: query,
    session_id: sessionId,
    base_sha: store.sessionBaseSha(sessionId),
    end_sha256: endSha(store, sessionId, query),
    mutations,
  };
}

// ── point-in-time reconstruction (R7.2b) ─────────────────────────────────────
// Rebuild a file's exact bytes at an arbitrary seq by replaying the recorded
// patches onto a recorded snapshot. GATED behind honesty: it NEVER emits a state
// it can't stand behind — it stops (and says why) rather than fabricate one.

export interface Reconstruction {
  path: string;
  seq: number;
  /** the reconstructed bytes, or the last good state when it had to stop. */
  content: string | null;
  /**
   * exact       — landed on a stored full-body write, or replay matched the
   *               end-of-session on-disk hash.
   * replayed    — patches applied cleanly, but UNVERIFIED (no ground-truth hash
   *               to confirm no unrecorded write intervened).
   * partial     — replay hit a divergence and stopped; `content` is the last good
   *               state, `divergence` says where + why.
   * unavailable — no in-session snapshot to anchor from (pre-session state needs
   *               the git base, not reconstructed here) or the anchor wasn't stored.
   */
  confidence: 'exact' | 'replayed' | 'partial' | 'unavailable';
  divergence?: { seq: number; reason: string };
}

interface Hunk {
  oldStr: string;
  newStr: string;
}

/** Re-derive each hunk's old/new snippet from the stored unified-diff-style patch
 *  (mutation.ts writes exactly one prefix char per line: ' ' context, '-' old,
 *  '+' new; MultiEdit joins several `@@` hunks). Verified unambiguous. */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: { old: string[]; nw: string[] } | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      if (cur) hunks.push({ oldStr: cur.old.join('\n'), newStr: cur.nw.join('\n') });
      cur = { old: [], nw: [] };
      continue;
    }
    if (!cur) continue;
    const p = line[0];
    const rest = line.slice(1);
    if (p === ' ') {
      cur.old.push(rest);
      cur.nw.push(rest);
    } else if (p === '-') {
      cur.old.push(rest);
    } else if (p === '+') {
      cur.nw.push(rest);
    }
  }
  if (cur) hunks.push({ oldStr: cur.old.join('\n'), newStr: cur.nw.join('\n') });
  return hunks;
}

/** Apply a patch's hunks to `content`, Edit-semantics: each old snippet replaced
 *  ONCE. Index-based splice (never String.replace — `$&`/`$'` hazard). Stops on a
 *  0-match (diverged) or >=2-match (ambiguous — the reconstructed base isn't proven
 *  to be the true state, so uniqueness isn't guaranteed). */
function applyPatch(content: string, patch: string): { content: string; ok: boolean; reason?: string } {
  let out = content;
  for (const h of parseHunks(patch)) {
    if (h.oldStr === '') return { content: out, ok: false, reason: 'a pure-insertion hunk has no anchor to locate' };
    const first = out.indexOf(h.oldStr);
    if (first === -1) return { content: out, ok: false, reason: 'the recorded old text is absent — the file diverged from the reconstructed base (likely an unrecorded write)' };
    if (out.indexOf(h.oldStr, first + 1) !== -1) return { content: out, ok: false, reason: 'the recorded old text matches in >=2 places — ambiguous, cannot place the edit safely' };
    out = out.slice(0, first) + h.newStr + out.slice(first + h.oldStr.length);
  }
  return { content: out, ok: true };
}

function stop(path: string, seq: number, content: string | null, divSeq: number, reason: string): Reconstruction {
  return { path, seq, content, confidence: 'partial', divergence: { seq: divSeq, reason } };
}

/**
 * Reconstruct the file's bytes as of `atSeq`. Anchors on the latest in-session
 * full-body Write at/before atSeq, then replays the patches after it. Refuses
 * (never fabricates) when it can't anchor or hits a divergence.
 */
export function reconstructAt(store: Store, sessionId: string, query: string, atSeq: number): Reconstruction {
  const h = fileHistory(store, sessionId, query);
  const upto = h.mutations.filter((m) => m.seq <= atSeq);
  if (!upto.length) return { path: query, seq: atSeq, content: null, confidence: 'unavailable' };

  let anchorIdx = -1;
  for (let i = upto.length - 1; i >= 0; i--) {
    if (upto[i]!.kind === 'body') {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx === -1) {
    return {
      path: query,
      seq: atSeq,
      content: null,
      confidence: 'unavailable',
      divergence: { seq: upto[0]!.seq, reason: 'no in-session snapshot before this seq; the pre-session state would need the git base (not reconstructed here)' },
    };
  }
  const anchor = upto[anchorIdx]!;
  if (anchor.content == null) {
    return { path: query, seq: atSeq, content: null, confidence: 'unavailable', divergence: { seq: anchor.seq, reason: `the snapshot at seq ${anchor.seq} was not stored (${anchor.skip_reason ?? 'pruned'})` } };
  }

  let content = anchor.content;
  for (let i = anchorIdx + 1; i < upto.length; i++) {
    const m = upto[i]!;
    if (m.redacted) return stop(query, atSeq, content, m.seq, 'a redacted mutation cannot be replayed (its content was scrubbed at capture)');
    if (m.tool === 'NotebookEdit') return stop(query, atSeq, content, m.seq, 'NotebookEdit cell sources are not line-replayable');
    if (m.content == null) return stop(query, atSeq, content, m.seq, `the patch at seq ${m.seq} was not stored (${m.skip_reason ?? 'pruned'})`);
    const r = applyPatch(content, m.content);
    if (!r.ok) return stop(query, atSeq, content, m.seq, r.reason!);
    content = r.content;
  }

  // Clean replay. Landing exactly on the anchoring Write (no patches after) is
  // exact. Otherwise it's replayed-but-unverified — unless we reached the file's
  // final mutation and it matches the R2 end-of-session on-disk hash, which both
  // CONFIRMS the replay and CATCHES a silent (ghost) divergence when it doesn't.
  const last = h.mutations[h.mutations.length - 1]!;
  if (upto[upto.length - 1]!.seq === last.seq && h.end_sha256) {
    const got = 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
    if (got === h.end_sha256) return { path: query, seq: atSeq, content, confidence: 'exact' };
    return stop(query, atSeq, content, last.seq, 'the reconstruction does not match the end-of-session on-disk hash — an unrecorded write intervened');
  }
  return { path: query, seq: atSeq, content, confidence: anchorIdx === upto.length - 1 ? 'exact' : 'replayed' };
}
