/**
 * R8 (AARM) — OpenTelemetry export. A PURE, re-derivable projection of the immutable
 * chain into the OTLP/JSON trace model, so a recorded session can be ingested by any
 * SIEM/APM that speaks OTLP. Never hashed, never written back — same discipline as
 * the risk and reconciliation layers.
 *
 * ZERO DEPS BY DESIGN: OTLP has a JSON-over-HTTP encoding, so the exporter is
 * JSON.stringify plus (optionally) fetch. The @opentelemetry/* packages are a large
 * dependency tree and would end the one-dependency install story for no capability
 * gain here — this is a serializer, not an instrumentation runtime.
 *
 * SHAPE: read-api.sessionActions() has already collapsed Pre/Post into one row with
 * a real duration, so the trace falls out of the existing projection:
 *
 *     session (root) ── turn (prompt_id) ── action (seq)
 *
 * The point of the export is `blackbox.seq` + `blackbox.event.hash` on every action
 * span: a row in someone else's SIEM still points back at a verifiable position in
 * the chain, so the telemetry is corroborable rather than merely copied.
 *
 * IDs are DERIVED (sha256 over session_id + seq), never random, so re-exporting the
 * same session is byte-identical. An evidence export that changed every run could
 * not be diffed or corroborated.
 *
 * LOW-LEAK BY DESIGN: exports only ALREADY-REDACTED derived fields — targets, the
 * plain-English action summary, flags, scores. NEVER blob content (prunable, and it
 * would outlive the data it quotes) and never `raw`. Same rule as search.ts.
 *
 * Semantic conventions: the `gen_ai.*` conventions are still unstable upstream, so
 * only the two settled keys are used; everything forensic lives under `blackbox.*`.
 */
import { createHash } from 'node:crypto';
import { INTENT_VERSION } from './intent';
import { safeParse } from './json';
import { RECON_VERSION } from './reconcile';
import { sessionActions, sessionCards, sessionName } from './read-api';
import type { Store } from './store';
import type { BlackboxEvent } from './types';

/** OTLP JSON encodes 64-bit ints as strings; anything else silently truncates. */
type AttrValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | { doubleValue: number }
  | { arrayValue: { values: AttrValue[] } };

interface Attr {
  key: string;
  value: AttrValue;
}

interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: Attr[];
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  events?: SpanEvent[];
  status?: { code: number; message?: string };
}

export interface OtlpPayload {
  resourceSpans: {
    resource: { attributes: Attr[] };
    scopeSpans: { scope: { name: string }; spans: Span[] }[];
  }[];
}

export interface OtlpOptions {
  /** Resource-level recorder identity (AARM R6). Omitted when the store is unkeyed. */
  recorderId?: string | null;
}

const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** Drops null/undefined/empty — an attribute with no value is noise in a SIEM. */
function attr(key: string, v: unknown): Attr | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v ? { key, value: { stringValue: v } } : null;
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  }
  if (Array.isArray(v)) {
    const values = v.map((x) => attr(key, x)).filter((a): a is Attr => a !== null).map((a) => a.value);
    return values.length ? { key, value: { arrayValue: { values } } } : null;
  }
  return null;
}

function attrs(rec: Record<string, unknown>): Attr[] {
  return Object.entries(rec)
    .map(([k, v]) => attr(k, v))
    .filter((a): a is Attr => a !== null);
}

/** Deterministic trace/span id. All-zero is invalid per the spec, so nudge it. */
function hexId(input: string, bytes: number): string {
  const h = createHash('sha256').update(input).digest('hex').slice(0, bytes * 2);
  return /^0+$/.test(h) ? h.slice(0, -1) + '1' : h;
}

/** ISO → uint64 nanoseconds, as a decimal string. BigInt is REQUIRED: epoch-ms ×
 *  1e6 is ~1.8e18, far past Number.MAX_SAFE_INTEGER, so plain arithmetic silently
 *  loses precision and every span lands on the wrong nanosecond. */
function nano(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return (BigInt(ms) * 1_000_000n).toString();
}

function maxNano(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

/** Build the OTLP payload for one or more sessions. Each session is its own trace. */
export function toOtlp(store: Store, sessionIds: string[], opts: OtlpOptions = {}): OtlpPayload {
  const cards = sessionCards(store);
  const spans: Span[] = [];
  for (const sid of sessionIds) {
    spans.push(...sessionSpans(store, sid, cards.find((c) => c.session_id === sid) ?? null));
  }
  const resource = {
    attributes: attrs({
      'service.name': 'blackbox',
      'blackbox.recorder_id': opts.recorderId ?? null,
      'blackbox.export.kind': 'forensic-record',
    }),
  };
  return { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'blackbox' }, spans }] }] };
}

type Card = ReturnType<typeof sessionCards>[number];

function sessionSpans(store: Store, sessionId: string, card: Card | null): Span[] {
  const events = store.eventsLight(sessionId);
  if (!events.length) return [];
  const bySeq = new Map<number, BlackboxEvent>(events.map((e) => [e.seq, e]));
  const actions = sessionActions(store, sessionId);

  const traceId = hexId(sessionId, 16);
  const rootId = hexId(sessionId + ':session', 8);
  const start = nano(events[0]!.ts);
  const end = nano(events[events.length - 1]!.ts);
  if (!start || !end) return []; // unparseable clock — export nothing rather than garbage

  const spans: Span[] = [];
  let rootEnd = end;

  // ---- action spans, grouped by turn --------------------------------------
  const turnBounds = new Map<string, { start: string; end: string }>();
  for (const a of actions) {
    // Lifecycle and synthetic-fact rows (session_start/prompt/reasoning/stop/
    // session_end, plus the worktree + env snapshots) all normalize to action_type
    // 'session'. They are not tool calls — the root span already covers the session,
    // so emitting them here would nest a span named "session" under a turn.
    if (a.type === 'session') continue;
    const s = nano(a.ts);
    if (!s) continue;
    const post = a.post_seq !== null ? bySeq.get(a.post_seq) : undefined;
    const e =
      a.duration_ms !== null && a.duration_ms >= 0
        ? (BigInt(s) + BigInt(Math.round(a.duration_ms)) * 1_000_000n).toString()
        : nano(post?.ts) ?? s;
    const span: Span = {
      traceId,
      spanId: hexId(sessionId + ':act:' + a.seq, 8),
      parentSpanId: a.prompt_id ? hexId(sessionId + ':turn:' + a.prompt_id, 8) : rootId,
      name: a.tool ? 'execute_tool ' + a.tool : a.type,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: s,
      endTimeUnixNano: maxNano(s, e),
      attributes: attrs({
        'gen_ai.operation.name': a.tool ? 'execute_tool' : null,
        'gen_ai.tool.name': a.tool,
        // The corroboration anchor: this row's position in the verifiable chain.
        'blackbox.seq': a.seq,
        'blackbox.event.hash': bySeq.get(a.seq)?.hash ?? null,
        'blackbox.post_seq': a.post_seq,
        'blackbox.action.type': a.type,
        'blackbox.action.target': a.target,
        'blackbox.action.summary': a.summary,
        'blackbox.agent.type': a.agent_type,
        'blackbox.prompt_id': a.prompt_id,
        'blackbox.redaction_count': a.redaction_count,
        'blackbox.risk.score': a.score,
        'blackbox.risk.flags': a.signals,
        'blackbox.risk.notes': a.notes,
      }),
      status: a.success === 0 ? { code: STATUS_ERROR, message: 'tool call failed' } : { code: STATUS_OK },
    };
    // Findings surface as span events so they are visible in any trace UI.
    const findings = [...a.signals, ...a.notes];
    if (findings.length) {
      span.events = findings.map((f) => ({ timeUnixNano: s, name: 'blackbox.finding', attributes: attrs({ 'blackbox.flag': f }) }));
    }
    spans.push(span);

    if (a.prompt_id) {
      const b = turnBounds.get(a.prompt_id);
      if (!b) turnBounds.set(a.prompt_id, { start: s, end: span.endTimeUnixNano });
      else turnBounds.set(a.prompt_id, { start: BigInt(s) < BigInt(b.start) ? s : b.start, end: maxNano(b.end, span.endTimeUnixNano) });
    }
    rootEnd = maxNano(rootEnd, span.endTimeUnixNano);
  }

  // ---- turn spans ---------------------------------------------------------
  // Intent divergence is per-turn, so it rides the turn span rather than the root.
  const intent = store.sessionIntent(sessionId, INTENT_VERSION);
  const divergence = new Map<string, { type: string; kind: string; value: string }[]>();
  for (const d of safeParse<{ type: string; kind: string; value: string; prompt_id: string }[]>(intent?.findings ?? null, [])) {
    divergence.set(d.prompt_id, [...(divergence.get(d.prompt_id) ?? []), d]);
  }
  for (const [promptId, b] of turnBounds) {
    const span: Span = {
      traceId,
      spanId: hexId(sessionId + ':turn:' + promptId, 8),
      parentSpanId: rootId,
      name: 'turn',
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: b.start,
      endTimeUnixNano: b.end,
      attributes: attrs({ 'blackbox.prompt_id': promptId, 'blackbox.session.id': sessionId }),
    };
    const divs = divergence.get(promptId);
    if (divs?.length) {
      span.events = divs.map((d) => ({
        timeUnixNano: b.start,
        name: 'blackbox.intent_divergence',
        attributes: attrs({ 'blackbox.divergence.type': d.type, 'blackbox.divergence.kind': d.kind, 'blackbox.divergence.value': d.value }),
      }));
    }
    spans.push(span);
  }

  // ---- root session span --------------------------------------------------
  const recon = store.sessionReconciliation(sessionId, RECON_VERSION);
  const root: Span = {
    traceId,
    spanId: rootId,
    name: 'session',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start,
    endTimeUnixNano: maxNano(start, rootEnd),
    attributes: attrs({
      'blackbox.session.id': sessionId,
      'blackbox.session.name': sessionName(store, sessionId),
      'blackbox.session.events': events.length,
      'blackbox.session.cwd': card?.cwd ?? null,
      'blackbox.session.verdict': card?.verdict ?? null,
      'blackbox.session.score': card?.score ?? null,
      'blackbox.session.failures': card?.failures ?? null,
      'blackbox.ruleset_version': card?.ruleset_version ?? null,
      'blackbox.reconciliation.version': recon ? RECON_VERSION : null,
      'blackbox.reconciliation.corroborated': recon ? recon.corroborated === 1 : null,
      'blackbox.reconciliation.finding_count': recon?.finding_count ?? null,
    }),
    status: card?.verdict === 'high' ? { code: STATUS_ERROR, message: 'session verdict: high' } : { code: STATUS_OK },
  };
  const rootEvents: SpanEvent[] = [];
  for (const c of card?.combos ?? []) {
    rootEvents.push({ timeUnixNano: start, name: 'blackbox.combo', attributes: attrs({ 'blackbox.combo.id': c.id, 'blackbox.combo.severity': c.severity }) });
  }
  for (const d of safeParse<{ type: string; path: string }[]>(recon?.findings ?? null, [])) {
    rootEvents.push({ timeUnixNano: start, name: 'blackbox.reconciliation', attributes: attrs({ 'blackbox.finding.type': d.type, 'blackbox.finding.path': d.path }) });
  }
  if (rootEvents.length) root.events = rootEvents;
  spans.unshift(root);

  return spans;
}

/** POST the payload to an OTLP/HTTP collector. The ONLY network path in this file,
 *  and it is only ever reached from an explicit `--endpoint` on the CLI — the daemon
 *  never exports, so `anchor.ts` remains the only code that sends bytes unprompted. */
export async function postOtlp(endpoint: string, payload: OtlpPayload, timeoutMs = 10_000): Promise<{ ok: boolean; status?: number; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `collector returned ${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
