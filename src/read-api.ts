import { RULESET_VERSION, type FlagId } from './risk-rules';
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
  signals: FlagId[];
  score: number;
  prompt_id: string | null;
  agent_type: string | null;
}

export interface ComboEvidence {
  id: string;
  severity: string;
  antecedent_seq: number;
  consequent_seq: number;
  note: string;
}

export interface SessionCard {
  session_id: string;
  events: number;
  started: string;
  ended: string;
  failures: number;
  verdict: string; // none | low | medium | high | unscored
  score: number;
  ruleset_version: string;
  combos: ComboEvidence[];
  flags: Record<string, number>;
  flagged: number;
  cwd: string | null;
}

const isPre = (e: BlackboxEvent): boolean => e.hook_event === 'PreToolUse';
const isPost = (e: BlackboxEvent): boolean => e.hook_event === 'PostToolUse' || e.hook_event === 'PostToolUseFailure';

const VERDICT_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3, unscored: 4 };

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// Cache keyed on chain head_seq: the store is append-only and the daemon writes
// risk right after each append, so a result is valid until head_seq advances.
let cardsCache: { head: number; cards: SessionCard[] } | null = null;
const actionsCache = new Map<string, { head: number; actions: Action[] }>();
const headSeq = (store: Store): number => store.chainMeta()?.head_seq ?? 0;

// A session's first non-null cwd is immutable (append-only store), so cache it
// forever once found — this avoids re-scanning every session's events on each
// head advance just to label the rail with a project path.
const cwdCache = new Map<string, string | null>();
function sessionCwd(store: Store, sessionId: string): string | null {
  const hit = cwdCache.get(sessionId);
  if (hit !== undefined && hit !== null) return hit;
  if (cwdCache.size > 4096) cwdCache.clear();
  const cwd = store.eventsLight(sessionId).find((e) => e.cwd)?.cwd ?? null;
  cwdCache.set(sessionId, cwd);
  return cwd;
}

/** Sessions with their persisted risk verdict, highest-risk first. */
export function sessionCards(store: Store): SessionCard[] {
  const head = headSeq(store);
  if (cardsCache && cardsCache.head === head) return cardsCache.cards;

  const risk = new Map(store.sessionRiskAll(RULESET_VERSION).map((r) => [r.session_id, r]));
  const cards: SessionCard[] = store.sessions().map((s) => {
    const r = risk.get(s.session_id);
    // First non-null cwd in the session — the UI shows the project a session ran in.
    const cwd = sessionCwd(store, s.session_id);
    if (!r) {
      return { ...s, verdict: 'unscored', score: 0, ruleset_version: RULESET_VERSION, combos: [], flags: {}, flagged: 0, cwd };
    }
    const flags = safeParse<Record<string, number>>(r.rule_counts, {});
    const flagged = Object.values(flags).reduce((a, b) => a + b, 0);
    return {
      ...s,
      verdict: r.verdict,
      score: r.score,
      ruleset_version: r.ruleset_version,
      combos: safeParse<ComboEvidence[]>(r.combos, []),
      flags,
      flagged,
      cwd,
    };
  });
  cards.sort((a, b) => (VERDICT_RANK[a.verdict] ?? 5) - (VERDICT_RANK[b.verdict] ?? 5) || (a.ended < b.ended ? 1 : -1));
  cardsCache = { head, cards };
  return cards;
}

/** The Pre/Post-paired timeline for one session, annotated with persisted risk. */
export function sessionActions(store: Store, sessionId: string): Action[] {
  const head = headSeq(store);
  const cached = actionsCache.get(sessionId);
  if (cached && cached.head === head) return cached.actions;

  const events = store.eventsLight(sessionId);
  const riskBySeq = new Map(store.riskForSession(sessionId, RULESET_VERSION).map((r) => [r.seq, r]));
  const flagsFor = (seq: number): FlagId[] => safeParse<FlagId[]>(riskBySeq.get(seq)?.flags ?? null, []);
  const scoreFor = (seq: number): number => riskBySeq.get(seq)?.score ?? 0;

  const open = new Map<string, Action>();
  const actions: Action[] = [];

  for (const e of events) {
    const flags = flagsFor(e.seq);
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
        signals: [...flags],
        score: scoreFor(e.seq),
        prompt_id: e.prompt_id,
        agent_type: e.agent_type,
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
      a.score = Math.max(a.score, scoreFor(e.seq));
      for (const s of flags) if (!a.signals.includes(s)) a.signals.push(s);
      open.delete(e.tool_use_id);
    } else {
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
        signals: flags,
        score: scoreFor(e.seq),
        prompt_id: e.prompt_id,
        agent_type: e.agent_type,
      });
    }
  }

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
  const risk = store.riskForSession(e.session_id, RULESET_VERSION).find((r) => r.seq === seq);
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
    risk: risk ? { score: risk.score, flags: safeParse<string[]>(risk.flags, []), evidence: safeParse<unknown>(risk.evidence, null) } : null,
    prev_hash: e.prev_hash,
    hash: e.hash,
  };
}
