import { readFileSync } from 'node:fs';
import { ALWAYS_SHOW_ANNOTATIONS, ANNOTATION_FLAGS, RISK_FLAGS, RULESET_VERSION, rulesetNum, type FlagId, type RulesetVersion } from './risk-rules';
import type { SessionRiskRow, Store } from './store';
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
  signals: FlagId[]; // risk flags + always-show / on-combo annotations → red/muted row chips
  notes: FlagId[]; // muted annotations shown only in the expanded dossier
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
  server?: string; // tool-poisoning: the poisoned server
  host?: string; // optional external host evidence
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
  flags: Record<string, number>; // risk-flag counts only (drives the "N flagged" badge)
  annotations: Record<string, number>; // muted context counts (secret-touch, etc.)
  flagged: number;
  cwd: string | null;
  name: string | null; // human-readable session name (user /rename, else AI title)
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

/** Parse a stored JSON array, tolerating BOTH parse errors and a non-array shape.
 *  The risk layer is untrusted (re-derivable, not chained), so a corrupt/tampered
 *  `combos` value must never crash the timeline. */
function safeArray<T>(s: string | null): T[] {
  const v = safeParse<unknown>(s, null);
  return Array.isArray(v) ? (v as T[]) : [];
}

// Cache keyed on chain head_seq: the store is append-only and the daemon writes
// risk right after each append, so a result is valid until head_seq advances.
let cardsCache: { head: number; cards: SessionCard[] } | null = null;
const actionsCache = new Map<string, { head: number; actions: Action[] }>();
const headSeq = (store: Store): number => store.chainMeta()?.head_seq ?? 0;

// Version-fallback read: after an r2 bump but before backfill, a session only has
// r1 rows — render those rather than a blanket "unscored". Returns the highest
// ruleset for which the session has a verdict, or the current one if none yet.
function resolveRuleset(store: Store, sessionId: string): RulesetVersion {
  return store.sessionRisk(sessionId, RULESET_VERSION) ? RULESET_VERSION : 'r1';
}

// Split a seq's flags into row chips (signals) vs dossier-only context (notes):
// risk flags and always-show annotations always chip; other annotations chip only
// on a combo's cited seq (so the timeline shows exactly what a combo points at)
// and otherwise drop to notes — this is what silences the 345x secret-touch noise.
function splitFlags(flags: FlagId[], seq: number, comboSeqs: Set<number>): { signals: FlagId[]; notes: FlagId[] } {
  const signals: FlagId[] = [];
  const notes: FlagId[] = [];
  for (const f of flags) {
    if (RISK_FLAGS.has(f) || ALWAYS_SHOW_ANNOTATIONS.has(f) || (comboSeqs.has(seq) && ANNOTATION_FLAGS.has(f))) signals.push(f);
    else notes.push(f);
  }
  return { signals, notes };
}

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

/** Human-readable session name: the user's `/rename` (customTitle) if set, else
 *  the AI-generated title (aiTitle), read from the session transcript. Cached
 *  once found (names rarely change; a daemon restart re-resolves). */
const nameCache = new Map<string, string>();
function lastMatch(text: string, re: RegExp): string | null {
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1] ?? null;
  return last;
}
function sessionName(store: Store, sessionId: string): string | null {
  const cached = nameCache.get(sessionId);
  if (cached) return cached;
  const tp = store.sessionTranscriptPath(sessionId);
  if (!tp) return null;
  let text: string;
  try {
    text = readFileSync(tp, 'utf8');
  } catch {
    return null;
  }
  const raw = lastMatch(text, /"customTitle":"((?:[^"\\]|\\.)*)"/g) ?? lastMatch(text, /"aiTitle":"((?:[^"\\]|\\.)*)"/g);
  if (raw == null) return null;
  let name = raw;
  try {
    name = JSON.parse(`"${raw}"`); // unescape any JSON escapes
  } catch {
    /* keep raw */
  }
  if (nameCache.size > 4096) nameCache.clear();
  nameCache.set(sessionId, name);
  return name;
}

/** Sessions with their persisted risk verdict, highest-risk first. */
export function sessionCards(store: Store): SessionCard[] {
  const head = headSeq(store);
  if (cardsCache && cardsCache.head === head) return cardsCache.cards;

  // Merge r1 + r2 verdicts, preferring the highest ruleset per session — so cards
  // never blank out in the window between an r2 bump and the backfill pass.
  const risk = new Map<string, SessionRiskRow>();
  for (const r of store.sessionRiskAll('r1')) risk.set(r.session_id, r);
  for (const r of store.sessionRiskAll(RULESET_VERSION)) {
    const prev = risk.get(r.session_id);
    if (!prev || rulesetNum(r.ruleset_version) >= rulesetNum(prev.ruleset_version)) risk.set(r.session_id, r);
  }
  const cards: SessionCard[] = store
    .sessions()
    // Drop sessions with zero chat activity — ones that recorded only lifecycle
    // markers (a lone SessionStart/SessionEnd, no tool use, no Stop, no subagent).
    // Those are Claude Code sessions opened but never used; they only clutter the
    // rail. `activity` is stripped here so the card wire shape is unchanged.
    .filter((s) => s.activity > 0)
    .map(({ activity: _activity, ...s }) => {
    const r = risk.get(s.session_id);
    // First non-null cwd in the session — the UI shows the project a session ran in.
    const cwd = sessionCwd(store, s.session_id);
    const name = sessionName(store, s.session_id);
    if (!r) {
      return { ...s, verdict: 'unscored', score: 0, ruleset_version: RULESET_VERSION, combos: [], flags: {}, annotations: {}, flagged: 0, cwd, name };
    }
    // Split the persisted rule_counts: RISK_FLAGS drive the "N flagged" badge;
    // ANNOTATION_FLAGS stay as muted context (a truthful count, not 345).
    const all = safeParse<Record<string, number>>(r.rule_counts, {});
    const flags: Record<string, number> = {};
    const annotations: Record<string, number> = {};
    for (const [k, v] of Object.entries(all)) {
      if (RISK_FLAGS.has(k as FlagId)) flags[k] = v;
      else if (ANNOTATION_FLAGS.has(k as FlagId)) annotations[k] = v;
    }
    const flagged = Object.values(flags).reduce((a, b) => a + b, 0);
    return {
      ...s,
      verdict: r.verdict,
      score: r.score,
      ruleset_version: r.ruleset_version,
      combos: safeArray<ComboEvidence>(r.combos),
      flags,
      annotations,
      flagged,
      cwd,
      name,
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
  const ruleset = resolveRuleset(store, sessionId);
  const riskBySeq = new Map(store.riskForSession(sessionId, ruleset).map((r) => [r.seq, r]));
  const flagsFor = (seq: number): FlagId[] => safeParse<FlagId[]>(riskBySeq.get(seq)?.flags ?? null, []);
  const scoreFor = (seq: number): number => riskBySeq.get(seq)?.score ?? 0;
  // Seqs a fired combo cites as evidence — an annotation on one of these is
  // promoted from a dossier note to a visible row chip.
  const comboSeqs = new Set<number>();
  for (const c of safeArray<ComboEvidence>(store.sessionRisk(sessionId, ruleset)?.combos ?? null)) {
    comboSeqs.add(c.antecedent_seq);
    comboSeqs.add(c.consequent_seq);
  }

  const open = new Map<string, Action>();
  const actions: Action[] = [];

  for (const e of events) {
    const { signals, notes } = splitFlags(flagsFor(e.seq), e.seq, comboSeqs);
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
        signals: [...signals],
        notes: [...notes],
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
      for (const s of signals) if (!a.signals.includes(s)) a.signals.push(s);
      for (const n of notes) if (!a.notes.includes(n)) a.notes.push(n);
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
        signals,
        notes,
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
  const risk = store.riskForSession(e.session_id, resolveRuleset(store, e.session_id)).find((r) => r.seq === seq);
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
