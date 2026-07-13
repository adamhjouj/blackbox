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
