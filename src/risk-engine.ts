import { evaluateEvent, newRuleCtx, PUSH_SENDS, RULESET_VERSION, rulesFingerprint, type FlagId, type SessionRuleCtx } from './risk-rules';
import type { RiskRow, SessionRiskRow, Store } from './store';
import type { BlackboxEvent } from './types';

/** Max seq gap for the temporal (non-data-linked) exfil variant to fire (MEDIUM). */
const EXFIL_WINDOW = 20;

export type Verdict = 'none' | 'low' | 'medium' | 'high';
export type ComboId = 'exfil-chain';

export interface ComboFire {
  id: ComboId;
  severity: 'high' | 'medium';
  antecedent_seq: number;
  consequent_seq: number;
  note: string;
}

export interface EventRisk {
  seq: number;
  session_id: string;
  score: number;
  flags: FlagId[];
  evidence: Record<string, unknown> | null;
}

export interface SessionVerdict {
  session_id: string;
  verdict: Verdict;
  score: number;
  combos: ComboFire[];
  rule_counts: Record<string, number>;
  last_scored_seq: number;
}

interface SessionState {
  ctx: SessionRuleCtx;
  firstSecretTouchSeq: number | null;
  combos: Map<ComboId, ComboFire>;
  maxEventScore: number;
  ruleCounts: Record<string, number>;
  lastSeq: number;
}

function freshState(): SessionState {
  return { ctx: newRuleCtx(), firstSecretTouchSeq: null, combos: new Map(), maxEventScore: 0, ruleCounts: {}, lastSeq: 0 };
}

function aggregate(state: SessionState): Verdict {
  const combos = [...state.combos.values()];
  const sessionScore = Math.min(100, state.maxEventScore + 40 * combos.length);
  if (combos.some((c) => c.severity === 'high') || sessionScore >= 80) return 'high';
  if (combos.some((c) => c.severity === 'medium') || state.maxEventScore >= 50) return 'medium';
  if (state.maxEventScore > 0) return 'low';
  return 'none';
}

/**
 * Scores events into risk + session verdicts. Pure (no DB): the caller persists.
 * Mirrors the Correlator pattern — per-session in-memory state fed one event at a
 * time, in seq order. `hydrate` rebuilds a session's state from the store the first
 * time it's touched (daemon restart, or ingest into an existing session), so
 * new-mcp-server and combo antecedents survive across process lifetimes.
 */
export class RiskEngine {
  private states = new Map<string, SessionState>();
  private readonly maxSessions = 128;

  constructor(private hydrate?: (sessionId: string) => BlackboxEvent[]) {}

  private stateFor(sessionId: string, beforeSeq: number): SessionState {
    let state = this.states.get(sessionId);
    if (state) return state;
    state = freshState();
    if (this.hydrate) {
      for (const prior of this.hydrate(sessionId)) {
        if (prior.seq < beforeSeq) this.ingest(state, prior);
      }
    }
    if (this.states.size >= this.maxSessions) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    this.states.set(sessionId, state);
    return state;
  }

  /** Fold one event into a session's state; returns its hits + any new combo. */
  private ingest(state: SessionState, e: BlackboxEvent): { hits: ReturnType<typeof evaluateEvent>; fired: ComboFire[] } {
    const hits = evaluateEvent(e, state.ctx);
    for (const h of hits) {
      state.ruleCounts[h.flag] = (state.ruleCounts[h.flag] ?? 0) + 1;
      if (h.score > state.maxEventScore) state.maxEventScore = h.score;
    }
    if (hits.some((h) => h.flag === 'secret-touch') && state.firstSecretTouchSeq === null) {
      state.firstSecretTouchSeq = e.seq;
    }

    const fired: ComboFire[] = [];
    const send = hits.find((h) => h.flag === 'external-send');
    if (send && !state.combos.has('exfil-chain')) {
      const ev = (send.evidence ?? {}) as { host?: string; secret?: string; via?: string };
      if (ev.secret) {
        // Data-linked: a sensitive FILE is being sent to an external host — the
        // only near-zero-FP signal, so this is the HIGH case. (A redacted auth
        // header on a legit API call is NOT this, and no longer fires.)
        const ante = state.firstSecretTouchSeq !== null && state.firstSecretTouchSeq < e.seq ? state.firstSecretTouchSeq : e.seq;
        const cf: ComboFire = { id: 'exfil-chain', severity: 'high', antecedent_seq: ante, consequent_seq: e.seq, note: 'sensitive file ' + ev.secret + ' sent to ' + (ev.host ?? 'external host') };
        state.combos.set('exfil-chain', cf);
        fired.push(cf);
      } else if (
        state.firstSecretTouchSeq !== null &&
        state.firstSecretTouchSeq < e.seq &&
        e.seq - state.firstSecretTouchSeq <= EXFIL_WINDOW &&
        (PUSH_SENDS as string[]).includes(ev.via ?? '')
      ) {
        // Temporal correlation only (no proof the data flowed) → MEDIUM, not HIGH,
        // and bounded to a short window + a push-type send. Avoids the "read .env
        // then call an API" false alarm.
        const cf: ComboFire = { id: 'exfil-chain', severity: 'medium', antecedent_seq: state.firstSecretTouchSeq, consequent_seq: e.seq, note: 'secret-touch then external send to ' + (ev.host ?? 'external host') + ' (temporal, unverified)' };
        state.combos.set('exfil-chain', cf);
        fired.push(cf);
      }
    }
    state.lastSeq = e.seq;
    return { hits, fired };
  }

  /** Score one event. Returns the event's risk (null if no hits), any newly-fired
   *  combos, and the session's current verdict. Caller persists. */
  score(e: BlackboxEvent): { risk: EventRisk | null; combosFired: ComboFire[]; verdict: SessionVerdict } {
    const state = this.stateFor(e.session_id, e.seq);
    const { hits, fired } = this.ingest(state, e);

    let risk: EventRisk | null = null;
    if (hits.length) {
      const evidence: Record<string, unknown> = {};
      for (const h of hits) if (h.evidence) evidence[h.flag] = h.evidence;
      risk = {
        seq: e.seq,
        session_id: e.session_id,
        score: Math.max(...hits.map((h) => h.score)),
        flags: hits.map((h) => h.flag),
        evidence: Object.keys(evidence).length ? evidence : null,
      };
    }
    return {
      risk,
      combosFired: fired,
      verdict: {
        session_id: e.session_id,
        verdict: aggregate(state),
        score: Math.min(100, state.maxEventScore + 40 * state.combos.size),
        combos: [...state.combos.values()],
        rule_counts: state.ruleCounts,
        last_scored_seq: state.lastSeq,
      },
    };
  }
}

// ---- row converters (engine output → store rows) -------------------------

export function riskRowFrom(r: EventRisk, ruleset: string, now: string): RiskRow {
  return {
    seq: r.seq,
    ruleset_version: ruleset,
    session_id: r.session_id,
    score: r.score,
    flags: JSON.stringify(r.flags),
    evidence: r.evidence ? JSON.stringify(r.evidence) : null,
    computed_at: now,
  };
}

export function sessionRiskRowFrom(v: SessionVerdict, ruleset: string, now: string): SessionRiskRow {
  return {
    session_id: v.session_id,
    ruleset_version: ruleset,
    verdict: v.verdict,
    score: v.score,
    combos: v.combos.length ? JSON.stringify(v.combos) : null,
    rule_counts: JSON.stringify(v.rule_counts),
    last_scored_seq: v.last_scored_seq,
    rules_hash: rulesFingerprint(),
    computed_at: now,
  };
}

// ---- offline drivers (rescore CLI, ingest, startup backfill) -------------

/** Replay a session from the immutable chain and compute its risk WITHOUT writing.
 *  Pure — used by both rescore (then persists) and rescore --check (then diffs). */
export function computeSession(store: Store, sessionId: string): { verdict: SessionVerdict; risks: EventRisk[] } {
  const engine = new RiskEngine(); // replay explicitly in seq order, no hydrate needed
  const risks: EventRisk[] = [];
  let verdict: SessionVerdict = { session_id: sessionId, verdict: 'none', score: 0, combos: [], rule_counts: {}, last_scored_seq: 0 };
  for (const e of store.eventsLight(sessionId)) {
    const r = engine.score(e);
    if (r.risk) risks.push(r.risk);
    verdict = r.verdict;
  }
  return { verdict, risks };
}

/** Recompute a session's entire risk layer from the immutable chain and persist it.
 *  Never touches events/chain_meta, so verify() is byte-identical before and after. */
export function rescoreSession(store: Store, sessionId: string, ruleset = RULESET_VERSION): SessionVerdict {
  const { verdict, risks } = computeSession(store, sessionId);
  const now = new Date().toISOString();
  store.riskDelete(ruleset, sessionId);
  for (const r of risks) store.riskUpsert(riskRowFrom(r, ruleset, now));
  store.sessionRiskUpsert(sessionRiskRowFrom(verdict, ruleset, now));
  return verdict;
}

/** Score every session that has no up-to-date verdict for `ruleset`. */
export function backfill(store: Store, ruleset = RULESET_VERSION): { sessions: number; events: number } {
  let sessions = 0;
  let events = 0;
  for (const sid of store.unscoredSessions(ruleset)) {
    try {
      const v = rescoreSession(store, sid, ruleset);
      sessions++;
      events += v.last_scored_seq ? 1 : 0;
    } catch {
      // One bad session must not abort the whole backfill pass.
    }
  }
  return { sessions, events };
}
