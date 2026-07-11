import { eventSignals, newCtx, type SignalKey } from './signals';
import type { Store } from './store';
import type { BlackboxEvent } from './types';

/** One row in the timeline: a Pre/Post tool pair collapsed into a single action,
 *  or a standalone event (session lifecycle, git ref-change, orphan). */
export interface Action {
  key: string;
  seq: number;
  post_seq: number | null;
  ts: string;
  hook_event: string;
  type: string;
  tool: string | null;
  target: string | null;
  phase: string;
  success: 0 | 1 | null;
  duration_ms: number | null;
  redaction_count: number;
  signals: SignalKey[];
}

export interface SessionCard {
  session_id: string;
  events: number;
  started: string;
  ended: string;
  failures: number;
  flags: Partial<Record<SignalKey, number>>;
  flagged: number;
}

const isPre = (e: BlackboxEvent): boolean => e.hook_event === 'PreToolUse';
const isPost = (e: BlackboxEvent): boolean => e.hook_event === 'PostToolUse' || e.hook_event === 'PostToolUseFailure';

// The store is append-only, so any result is valid until head_seq advances. The
// UI polls every few seconds; without this each poll re-scans the whole store
// synchronously and can starve the /hook recording path. Caching by head_seq
// makes an idle poll O(1).
let cardsCache: { head: number; cards: SessionCard[] } | null = null;
const actionsCache = new Map<string, { head: number; actions: Action[] }>();
const headSeq = (store: Store): number => store.chainMeta()?.head_seq ?? 0;

/** Sessions with per-session signal counts, newest activity first. */
export function sessionCards(store: Store): SessionCard[] {
  const head = headSeq(store);
  if (cardsCache && cardsCache.head === head) return cardsCache.cards;

  const cards = store.sessions().map((s) => {
    const events = store.eventsLight(s.session_id);
    const ctx = newCtx();
    const flags: Partial<Record<SignalKey, number>> = {};
    let flagged = 0;
    for (const e of events) {
      for (const sig of eventSignals(e, ctx)) {
        flags[sig] = (flags[sig] ?? 0) + 1;
        flagged++;
      }
    }
    return { ...s, flags, flagged };
  });
  cards.sort((a, b) => (a.ended < b.ended ? 1 : -1));
  cardsCache = { head, cards };
  return cards;
}

/** The paired, signal-annotated timeline for one session. */
export function sessionActions(store: Store, sessionId: string): Action[] {
  const head = headSeq(store);
  const cached = actionsCache.get(sessionId);
  if (cached && cached.head === head) return cached.actions;

  const events = store.eventsLight(sessionId);
  const ctx = newCtx();
  const open = new Map<string, Action>();
  const actions: Action[] = [];

  for (const e of events) {
    const sig = eventSignals(e, ctx);
    if (isPre(e) && e.tool_use_id) {
      const a: Action = {
        key: e.tool_use_id,
        seq: e.seq,
        post_seq: null,
        ts: e.ts,
        hook_event: e.hook_event,
        type: e.action_type,
        tool: e.tool_name,
        target: e.target,
        phase: e.phase,
        success: null,
        duration_ms: null,
        redaction_count: e.redaction_count,
        signals: [...sig],
      };
      open.set(e.tool_use_id, a);
      actions.push(a);
    } else if (isPost(e) && e.tool_use_id && open.has(e.tool_use_id)) {
      const a = open.get(e.tool_use_id)!;
      a.post_seq = e.seq;
      a.success = e.success;
      a.duration_ms = e.duration_ms;
      a.phase = e.phase;
      a.redaction_count += e.redaction_count;
      for (const s of sig) if (!a.signals.includes(s)) a.signals.push(s);
      open.delete(e.tool_use_id);
    } else {
      // Standalone: SessionStart/Stop/SessionEnd, git_action, or an orphan Post.
      actions.push({
        key: `seq:${e.seq}`,
        seq: e.seq,
        post_seq: null,
        ts: e.ts,
        hook_event: e.hook_event,
        type: e.action_type,
        tool: e.tool_name,
        target: e.target,
        phase: e.phase,
        success: e.success,
        duration_ms: e.duration_ms,
        redaction_count: e.redaction_count,
        signals: sig,
      });
    }
  }
  // Bound the per-session cache so many sessions don't leak memory.
  if (actionsCache.size > 64) actionsCache.clear();
  actionsCache.set(sessionId, { head, actions });
  return actions;
}

/** Full detail for one event (by seq): parsed redacted payload, output provenance,
 *  collector detail, and the chain hashes so a skeptic can eyeball the link. */
export function eventDetail(store: Store, seq: number): Record<string, unknown> | null {
  const e = store.get(seq);
  if (!e) return null;
  let raw: unknown = e.raw;
  let detail: unknown = null;
  try {
    raw = JSON.parse(e.raw);
  } catch {
    /* keep string */
  }
  if (e.detail) {
    try {
      detail = JSON.parse(e.detail);
    } catch {
      detail = e.detail;
    }
  }
  return {
    seq: e.seq,
    event_id: e.event_id,
    session_id: e.session_id,
    tool_use_id: e.tool_use_id,
    phase: e.phase,
    hook_event: e.hook_event,
    tool_name: e.tool_name,
    action_type: e.action_type,
    target: e.target,
    ts: e.ts,
    duration_ms: e.duration_ms,
    output_hash: e.output_hash,
    output_size_bytes: e.output_size_bytes,
    redaction_count: e.redaction_count,
    raw,
    detail,
    prev_hash: e.prev_hash,
    hash: e.hash,
  };
}
