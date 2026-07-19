import { actionSummary, explainEvent } from './explain';
import { safeParse } from './json';
import { buildTrace, ALL_DEPTH, type TraceView } from './graph';
import { buildStory, type EventDetail, type SessionStory } from './provenance';
import { RECON_VERSION, type Coverage, type Discrepancy } from './reconcile';
import { recoverSessionTurns, sessionTitleFromTranscript } from './transcript';
import { ALWAYS_SHOW_ANNOTATIONS, ANNOTATION_FLAGS, KNOWN_RULESETS, RISK_FLAGS, RULESET_VERSION, rulesetNum, type FlagId, type RulesetVersion } from './risk-rules';
import { loadPublicKey, loadWatermark } from './sign';
import type { SessionRiskRow, Store } from './store';
import type { BlackboxEvent } from './types';
import { verify } from './verify';

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
  summary: string; // plain-English one-liner for the row (agent description, else synthesized)
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
  density: number[]; // event-count histogram over the session span (UI sparkline)
}

export const isPre = (e: BlackboxEvent): boolean => e.hook_event === 'PreToolUse';
export const isPost = (e: BlackboxEvent): boolean => e.hook_event === 'PostToolUse' || e.hook_event === 'PostToolUseFailure';

const VERDICT_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3, unscored: 4 };

/** Parse a stored JSON array, tolerating BOTH parse errors and a non-array shape.
 *  The risk layer is untrusted (re-derivable, not chained), so a corrupt/tampered
 *  `combos` value must never crash the timeline. */
function safeArray<T>(s: string | null): T[] {
  const v = safeParse<unknown>(s, null);
  return Array.isArray(v) ? (v as T[]) : [];
}

// A conservative guard for the blast-radius egress SUMMARY list. The scheme-less host
// detector mis-extracts "hosts" from analyzed code/fixtures (`x.db`, `foo.png`,
// truncated `127…`); reject anything without a dot, a bare/truncated token, or a
// final label that is provably a file extension rather than a TLD. Real IPs are kept.
// This trims the summary only — punycode (`xn--…`) and trailing-dot FQDNs are dropped
// too — but every send still counts in the egress total and appears in the per-event
// dossier, so nothing is truly hidden from a reviewer.
const NON_HOST_TLD = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'db', 'sqlite', 'sqlite3', 'log', 'lock', 'map', 'css', 'scss', 'less', 'md', 'txt', 'csv', 'pdf', 'zip', 'gz', 'tar']);
export function looksLikeHost(h: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  if (h.includes(':') && /^[0-9a-f:]+$/i.test(h)) return true; // IPv6-ish
  const parts = h.split('.');
  if (parts.length < 2) return false; // bare token / truncated value
  const tld = parts[parts.length - 1]!.toLowerCase();
  return /^[a-z]{2,}$/.test(tld) && !NON_HOST_TLD.has(tld);
}

// Cache keyed on chain head_seq: the store is append-only and the daemon writes
// risk right after each append, so a result is valid until head_seq advances.
let cardsCache: { head: number; cards: SessionCard[] } | null = null;
const actionsCache = new Map<string, { head: number; actions: Action[] }>();
const storyCache = new Map<string, { head: number; transcript: string; story: SessionStory }>();
const headSeq = (store: Store): number => store.chainMeta()?.head_seq ?? 0;

// Version-fallback read: after an r2 bump but before backfill, a session only has
// r1 rows — render those rather than a blanket "unscored". Returns the highest
// ruleset for which the session has a verdict, or the current one if none yet.
function resolveRuleset(store: Store, sessionId: string): RulesetVersion {
  // Highest ruleset for which the session has a verdict — walk ALL known versions
  // descending (not just current→r1), so an r2-only session between an r3 bump and
  // its backfill renders r2, never a stale r1 or a blank "unscored".
  for (const rs of [...KNOWN_RULESETS].sort((a, b) => rulesetNum(b) - rulesetNum(a))) {
    if (store.sessionRisk(sessionId, rs)) return rs;
  }
  return RULESET_VERSION;
}

// Split a seq's flags into row chips (signals) vs dossier-only context (notes):
// risk flags and always-show annotations always chip; other annotations chip only
// on a combo's cited seq (so the timeline shows exactly what a combo points at)
// and otherwise drop to notes — this is what silences the 345x secret-touch noise.
// The agent's own description, captured into `detail` at record time (light — no
// raw payload read). Older events won't have it; the summary then synthesizes.
function eventDescription(e: BlackboxEvent): string | null {
  if (!e.detail) return null;
  const d = safeParse<{ description?: unknown }>(e.detail, {});
  return typeof d.description === 'string' ? d.description : null;
}

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

/** Human-readable session name: the user's `/rename` (customTitle), else the
 *  transcript's AI title, else the first captured real prompt. The prompt fallback
 *  keeps imported/rotated-transcript sessions navigable instead of exposing a UUID.
 *  Transcript reads are bounded; event reads omit the heavy raw column. */
const nameCache = new Map<string, string>();
export function sessionName(store: Store, sessionId: string): string | null {
  const cached = nameCache.get(sessionId);
  if (cached) return cached;
  const tp = store.sessionTranscriptPath(sessionId);
  let name = tp ? sessionTitleFromTranscript(tp) : null;
  if (name == null) {
    const promptEvent = store.eventsLight(sessionId).find((event) => event.phase === 'prompt' && event.detail);
    const prompt = promptEvent ? safeParse<{ prompt?: unknown }>(promptEvent.detail, {}).prompt : null;
    if (typeof prompt === 'string') {
      const oneLine = prompt.replace(/\s+/g, ' ').trim();
      if (oneLine && !/^<(task-notification|system-reminder|command-|local-command-)/.test(oneLine)) {
        const points = Array.from(oneLine);
        name = points.length > 96 ? points.slice(0, 96).join('') + '…' : points.join('');
      }
    }
  }
  if (name == null) return null;
  if (nameCache.size > 4096) nameCache.clear();
  nameCache.set(sessionId, name);
  return name;
}

/** Sessions with their persisted risk verdict, highest-risk first. */
export function sessionCards(store: Store): SessionCard[] {
  const head = headSeq(store);
  if (cardsCache && cardsCache.head === head) return cardsCache.cards;

  // Merge verdicts across ALL known rulesets, preferring the highest per session —
  // so cards never blank out (or show a stale lower version) in the window between
  // a ruleset bump and the backfill pass. KNOWN_RULESETS is ascending, so keeping
  // the max as we go lands on the newest available verdict per session.
  const risk = new Map<string, SessionRiskRow>();
  for (const rs of KNOWN_RULESETS) {
    for (const r of store.sessionRiskAll(rs)) {
      const prev = risk.get(r.session_id);
      if (!prev || rulesetNum(r.ruleset_version) >= rulesetNum(prev.ruleset_version)) risk.set(r.session_id, r);
    }
  }
  const densities = store.sessionDensity(18);
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
    const density = densities.get(s.session_id) ?? [];
    if (!r) {
      return { ...s, verdict: 'unscored', score: 0, ruleset_version: RULESET_VERSION, combos: [], flags: {}, annotations: {}, flagged: 0, cwd, name, density };
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
      density,
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
        summary: actionSummary(e.action_type, e.target, e.tool_name, eventDescription(e)),
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
        summary: actionSummary(e.action_type, e.target, e.tool_name, eventDescription(e)),
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

/** The re-traceable session story: turns (prompt → steps → outcomes), projected
 *  from the immutable chain. Reuses sessionActions (Pair + risk) and the same
 *  head-seq cache discipline; the projection itself lives in provenance.ts. */
export function sessionStory(store: Store, sessionId: string): SessionStory {
  const head = headSeq(store);
  const transcriptPath = store.sessionTranscriptPath(sessionId);
  const recovery = transcriptPath ? recoverSessionTurns(transcriptPath, sessionId) : { fingerprint: '', turns: new Map() };
  const cached = storyCache.get(sessionId);
  if (cached && cached.head === head && cached.transcript === recovery.fingerprint) return cached.story;

  const actions = sessionActions(store, sessionId);
  // detail carries prompt / mutation / git — parse it once per event (light: no raw).
  const detailBySeq = new Map<number, EventDetail>();
  for (const e of store.eventsLight(sessionId)) {
    if (!e.detail) continue;
    const d = safeParse<EventDetail | null>(e.detail, null);
    if (d && typeof d === 'object') detailBySeq.set(e.seq, d);
  }
  const ruleset = resolveRuleset(store, sessionId);
  const story = buildStory({
    session_id: sessionId,
    name: sessionName(store, sessionId),
    cwd: sessionCwd(store, sessionId),
    verdict: store.sessionRisk(sessionId, ruleset)?.verdict ?? 'unscored',
    actions,
    detailBySeq,
    recoveredTurns: recovery.turns,
  });

  // R2: attach the persisted reconciliation summary (git ground truth vs hooks).
  const recon = store.sessionReconciliation(sessionId, RECON_VERSION);
  if (recon) {
    story.reconciliation = {
      corroborated: recon.corroborated === 1,
      finding_count: recon.finding_count,
      findings: safeArray<Discrepancy>(recon.findings),
      coverage: safeParse<Coverage>(recon.coverage, { corroborated: recon.corroborated === 1, reason: null, files_on_disk: 0, hook_files: 0, truncated: false }),
    };
  }

  // Blast radius (read-only rollup): the KINDS of secret the redactor caught + the
  // external hosts reached. Assembled from the redaction facts (detail.redaction,
  // already parsed above — we take `type`, the secret class, NOT `path`, which is a
  // payload field-location) + the per-event risk evidence (keyed by flag). Egress
  // hosts that a combo actually correlated (confirmed exfil) are surfaced first. No
  // capture change; pure read projection.
  const secretKinds = new Set<string>();
  for (const d of detailBySeq.values()) {
    const reds = (d as { redaction?: unknown }).redaction;
    if (Array.isArray(reds)) for (const r of reds) { const t = r && (r as { type?: unknown }).type; if (typeof t === 'string') secretKinds.add(t); }
  }
  const comboHosts = safeArray<ComboEvidence>(store.sessionRisk(sessionId, ruleset)?.combos ?? null)
    .map((c) => c.host)
    .filter((h): h is string => typeof h === 'string' && looksLikeHost(h));
  const egressHosts = new Set<string>(comboHosts); // combo-confirmed first (Set keeps insertion order)
  for (const rr of store.riskForSession(sessionId, ruleset)) {
    const ev = safeParse<Record<string, { host?: unknown }> | null>(rr.evidence, null);
    const host = ev && ev['external-send'] && ev['external-send'].host;
    if (typeof host === 'string' && looksLikeHost(host)) egressHosts.add(host);
  }
  story.blast_radius = { secret_kinds: [...secretKinds].sort(), egress_hosts: [...egressHosts].slice(0, 24) };

  if (storyCache.size > 64) storyCache.clear();
  storyCache.set(sessionId, { head, transcript: recovery.fingerprint, story });
  return story;
}

/** R4 — the provenance TRACE for a session: a causal DAG rooted at a finding (or a
 *  chosen node), showing ancestry + descendants out to `depth` hops, laid out
 *  deterministically. A pure read-time projection of the story + risk combos —
 *  nothing is written, nothing hashed, `verify()` untouched. */
export interface TraceParams {
  root?: string | null;
  depth?: number | null; // hop radius; ALL_DEPTH / whole for "all"
  whole?: boolean; // the whole session instead of a rooted trace
  expand?: string[]; // aggregate 'dir' nodes the user has opened
}
export function sessionTrace(store: Store, sessionId: string, params?: TraceParams): TraceView {
  const story = sessionStory(store, sessionId);
  const ruleset = resolveRuleset(store, sessionId);
  const combos = safeArray<ComboEvidence>(store.sessionRisk(sessionId, ruleset)?.combos ?? null);
  const p = params ?? {};
  const depth = p.whole ? ALL_DEPTH : p.depth ?? null;
  return buildTrace(story, combos, { root: p.root ?? null, depth, whole: !!p.whole, expand: p.expand ?? [] });
}

export interface MutationView {
  kind: string;
  diffstat: unknown;
  bytes: number;
  redacted: boolean;
  /** available: content present · pruned: aged out (tombstone) · skipped: never stored. */
  status: 'available' | 'pruned' | 'skipped';
  skip_reason: string | null;
  content: string | null;
  pruned_at: string | null;
}

/** Reconstruct the mutation view from the immutable FACT (detail.mutation) + the
 *  prunable blob. Pure read-time interpretation — never persisted. */
function reconstructMutation(store: Store, detail: unknown): MutationView | null {
  if (!detail || typeof detail !== 'object') return null;
  const m = (detail as Record<string, unknown>).mutation;
  if (!m || typeof m !== 'object') return null;
  const f = m as Record<string, unknown>;
  const hash = typeof f.content_hash === 'string' ? f.content_hash : null;
  const stored = f.stored !== false;

  let status: MutationView['status'] = 'skipped';
  let content: string | null = null;
  let pruned_at: string | null = null;
  if (stored) {
    const blob = hash ? store.blobGet(hash) : null;
    if (blob && blob.content != null) {
      status = 'available';
      content = blob.content;
    } else {
      status = 'pruned';
      pruned_at = blob?.pruned_at ?? null;
    }
  }
  return {
    kind: typeof f.kind === 'string' ? f.kind : 'patch',
    diffstat: f.diffstat ?? null,
    bytes: typeof f.bytes === 'number' ? f.bytes : 0,
    redacted: f.redacted === true,
    status,
    skip_reason: typeof f.skip_reason === 'string' ? f.skip_reason : null,
    content,
    pruned_at,
  };
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
  const flags = risk ? safeParse<FlagId[]>(risk.flags, []) : [];
  // The redacted tool_input drives the plain-English explanation (and carries
  // extras like `dangerouslyDisableSandbox`). Re-derived at read time, never stored.
  const rawInput = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).tool_input : null;
  const explanation = explainEvent(e, flags, rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : null);
  // A mutation fact rides on the POST event; a timeline row expands its PRE event,
  // so fall back to the paired Post's detail — otherwise expanding an edit shows no
  // diff (the "I can't see what changed" bug). The story view drills into post_seq
  // directly and never needs this fallback.
  let mutation = reconstructMutation(store, detail);
  if (!mutation && e.phase === 'pre' && e.tool_use_id) {
    const post = store.postFor(e.tool_use_id, e.seq);
    if (post) mutation = reconstructMutation(store, safeParse<unknown>(post.detail, null));
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
    explanation,
    raw,
    detail,
    mutation,
    risk: risk ? { score: risk.score, flags: safeParse<string[]>(risk.flags, []), evidence: safeParse<unknown>(risk.evidence, null) } : null,
    prev_hash: e.prev_hash,
    hash: e.hash,
  };
}

/** R3 chain-of-custody status for the forensic "verified" badge. A READ-ONLY view:
 *  it calls verify() (which stays byte-identical — nothing here changes the chain
 *  or its logic) plus the cheap signature/head lookups. NOT on the 3s poll path —
 *  the UI fetches this once per session-open — and cached on head_seq so repeated
 *  opens at the same chain head don't re-walk. */
export interface VerifyStatus {
  ok: boolean;
  break_reason: string | null;
  head_seq: number;
  count: number;
  signed: boolean;
  latest_sig_seq: number | null;
  latest_sig_ts: string | null;
}
let verifyCache: { head: number; status: VerifyStatus } | null = null;
export function verifyStatus(store: Store): VerifyStatus {
  const head = headSeq(store);
  if (verifyCache && verifyCache.head === head) return verifyCache.status;
  let ok = false;
  let break_reason: string | null = null;
  let head_seq = 0;
  let count = 0;
  let signed = false;
  let latest_sig_seq: number | null = null;
  let latest_sig_ts: string | null = null;
  // Everything (incl. the key/signature reads) is inside the try: a corrupt key or
  // signature file must degrade to a "verify-error" badge, never 500 the endpoint.
  try {
    const meta = store.chainMeta();
    head_seq = meta?.head_seq ?? 0;
    count = meta?.count ?? 0;
    const sig = store.latestSignature();
    const pub = loadPublicKey();
    signed = !!sig && !!pub;
    latest_sig_seq = sig?.seq ?? null;
    latest_sig_ts = sig?.ts ?? null;
    const vr = verify(store, { trustedPublicKey: pub, watermark: loadWatermark() });
    ok = vr.ok;
    break_reason = vr.ok ? null : (vr.break?.reason ?? 'broken');
  } catch {
    break_reason = 'verify-error';
  }
  const status: VerifyStatus = { ok, break_reason, head_seq, count, signed, latest_sig_seq, latest_sig_ts };
  verifyCache = { head, status };
  return status;
}
