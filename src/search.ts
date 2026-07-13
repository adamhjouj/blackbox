/**
 * R8.2 — corpus search. A pure, re-derivable projection over the immutable chain
 * into an FTS5 index (like the risk layer: never hashed, rebuildable). Indexes only
 * ALREADY-REDACTED text — target paths/commands, the plain-English action summary,
 * the turn prompt, the reasoning digest, and commit subjects — NEVER blob content
 * (which is prunable and would outlive the data it quotes).
 *
 * The index is maintained incrementally by a monotonic seq watermark (events are
 * append-only and never updated/deleted, so a watermark is sufficient and there
 * are NO triggers — an FTS failure must never fail a recording).
 */
import { actionSummary } from './explain';
import type { Store } from './store';
import type { BlackboxEvent } from './types';

const BATCH = 2000;

export interface SearchHit {
  seq: number;
  session_id: string;
  kind: string;
  ts: string;
  snippet: string;
}

/** The indexable (redacted) text + a coarse kind for one event, or null if empty. */
function indexableText(e: BlackboxEvent): { kind: string; text: string } | null {
  let detail: Record<string, unknown> = {};
  try {
    detail = e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : {};
  } catch {
    /* tolerate malformed detail */
  }
  const parts: string[] = [];
  if (e.target) parts.push(e.target);
  const desc = typeof detail.description === 'string' ? detail.description : null;
  const summary = actionSummary(e.action_type, e.target, e.tool_name, desc);
  if (summary) parts.push(summary);
  if (typeof detail.prompt === 'string') parts.push(detail.prompt);
  if (typeof detail.reasoning === 'string') parts.push(detail.reasoning);
  const git = detail.git as { commit?: { subject?: unknown } } | undefined;
  const commitSubject = git?.commit && typeof git.commit.subject === 'string' ? git.commit.subject : null;
  if (commitSubject) parts.push(commitSubject);

  const text = parts.filter(Boolean).join(' — ').trim();
  if (!text) return null;
  const kind = e.phase === 'prompt' ? 'prompt' : e.phase === 'reasoning' ? 'reasoning' : commitSubject ? 'commit' : e.action_type;
  return { kind, text };
}

/** Index every event past the watermark (deduping Pre/Post pairs to the Pre row).
 *  Returns how many rows were added. Cheap + idempotent — safe to call on a timer. */
export function indexNew(store: Store): number {
  let from = store.searchLastIndexed();
  let added = 0;
  for (;;) {
    const events = store.eventsAfter(from, BATCH);
    if (!events.length) break;
    const rows: { seq: number; session_id: string; kind: string; ts: string; text: string }[] = [];
    for (const e of events) {
      if ((e.phase === 'post' || e.phase === 'failure') && e.tool_use_id) continue; // Pre already carries the target
      const t = indexableText(e);
      if (t) rows.push({ seq: e.seq, session_id: e.session_id, kind: t.kind, ts: e.ts, text: t.text });
    }
    const upTo = events[events.length - 1]!.seq;
    store.searchIndexRows(rows, upTo);
    added += rows.length;
    from = upTo;
    if (events.length < BATCH) break;
  }
  return added;
}

/** Rebuild the whole index from scratch (`blackbox reindex`). */
export function reindexAll(store: Store): number {
  store.searchReset();
  return indexNew(store);
}

/** Run a search. Sanitises the FTS query (raw first, then a quoted-phrase fallback
 *  so punctuation / syntax errors degrade instead of throwing). LIMIT-bounded. */
export function search(store: Store, query: string, limit = 200): { hits: SearchHit[] } {
  const q = query.trim();
  if (!q) return { hits: [] };
  const attempts = [q, '"' + q.replace(/"/g, ' ') + '"']; // raw, then quoted phrase
  for (const m of attempts) {
    try {
      return { hits: store.searchQuery(m, limit) };
    } catch {
      /* FTS syntax error — try the safer form */
    }
  }
  return { hits: [] };
}
