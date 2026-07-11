/**
 * Session report export (Phase 4) — the one command that turns a recorded session
 * into a clean, paste-able Markdown dossier: the artifact a developer drops into a
 * PR comment, a Slack thread, or an incident ticket. This is the product's growth
 * surface (ARCHITECTURE.md §9) — a forensic record is only useful if a human can
 * read it and act on it, so the report speaks plain English and always ends with a
 * concrete "what to check" list.
 *
 * Like the rest of the read layer, it is a pure READ-time projection of already-
 * stored facts: the immutable event chain plus the re-derivable risk layer. It
 * never writes, never rescores, and never touches the hash chain. Risk is read
 * from the persisted layer with the same r2→r1 version fallback the UI uses.
 */
import { readFileSync } from 'node:fs';
import { explainEvent, type Danger } from './explain';
import { sessionCards } from './read-api';
import type { ComboFire } from './risk-engine';
import { RISK_FLAGS, RULESET_VERSION, type FlagId, type RulesetVersion } from './risk-rules';
import type { Store } from './store';
import type { BlackboxEvent } from './types';

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// Version-fallback read (mirrors read-api.resolveRuleset): after an r2 bump but
// before backfill a session only has r1 rows — report those rather than blank
// "unscored". Returns the highest ruleset for which the session has a verdict.
function resolveRuleset(store: Store, sessionId: string): RulesetVersion {
  return store.sessionRisk(sessionId, RULESET_VERSION) ? RULESET_VERSION : 'r1';
}

/** The parsed tool_input from an event's raw payload, for explainEvent. The report
 *  path can afford reading raw (one session, one command); the timeline path can't. */
function toolInputOf(raw: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(raw) as unknown;
    const ti = j && typeof j === 'object' ? (j as Record<string, unknown>).tool_input : null;
    return ti && typeof ti === 'object' ? (ti as Record<string, unknown>) : null;
  } catch {
    return null; // raw may be a non-JSON string (kept verbatim on parse failure)
  }
}

const isPre = (e: BlackboxEvent): boolean => e.hook_event === 'PreToolUse';
const isPost = (e: BlackboxEvent): boolean => e.hook_event === 'PostToolUse' || e.hook_event === 'PostToolUseFailure';

/** Deduped action count for the header line — a Pre/Post pair is one action, a
 *  standalone event is one, and bare session-lifecycle markers don't count. */
function countActions(events: BlackboxEvent[]): number {
  const open = new Set<string>();
  let n = 0;
  for (const e of events) {
    if (e.action_type === 'session') continue;
    if (isPost(e) && e.tool_use_id && open.has(e.tool_use_id)) {
      open.delete(e.tool_use_id); // merged into its Pre — not a new action
      continue;
    }
    if (isPre(e) && e.tool_use_id) open.add(e.tool_use_id);
    n++;
  }
  return n;
}

const HH_MM_SS = (ts: string): string => (/^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)/.exec(ts)?.[1] ?? ts);

/** Human duration between two ISO timestamps (e.g. "1h 4m", "12s"). */
function formatDuration(started: string, ended: string): string {
  const ms = new Date(ended).getTime() - new Date(started).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || !parts.length) parts.push(`${sec}s`);
  return parts.join(' ');
}

// Combo id → plain-English label. Falls back to the raw id for forward-compat.
const COMBO_LABEL: Record<string, string> = {
  'exfil-chain': 'Exfiltration chain',
  'injected-tamper': 'Injection → auth/permission tamper',
  'injected-exfil': 'Injection → data exfiltration',
  'injected-rce': 'Injection → remote code execution',
  'injected-ci-write': 'Injection → CI/build-config write',
  'tool-poisoning': 'Tool poisoning',
};

// Human-readable session name: the user's /rename (customTitle), else the AI title
// (aiTitle), read from the session transcript — the same source read-api uses.
function lastMatch(text: string, re: RegExp): string | null {
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1] ?? null;
  return last;
}
function sessionName(store: Store, sessionId: string): string | null {
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
  try {
    return JSON.parse(`"${raw}"`); // unescape JSON escapes
  } catch {
    return raw;
  }
}

/** One RISK-flagged action, collapsed across its Pre/Post rows. */
interface FlaggedEntry {
  seq: number;
  ts: string;
  summary: string;
  flags: FlagId[];
  dangers: Danger[];
}

/**
 * Build a shareable Markdown report for one session. Deterministic and local; risk
 * is read from the persisted layer under `ruleset` (default: r2→r1 fallback).
 */
export function buildReport(store: Store, sessionId: string, ruleset?: RulesetVersion): string {
  const rs = ruleset ?? resolveRuleset(store, sessionId);
  const events = store.eventsLight(sessionId);
  const name = sessionName(store, sessionId);
  const L: string[] = [];

  L.push(`# Blackbox session report — ${name ?? sessionId}`, '');

  if (events.length === 0) {
    L.push(`No events recorded for session \`${sessionId}\`.`, '');
    return L.join('\n');
  }

  // ── metadata ────────────────────────────────────────────────────────────
  const summary = store.sessions().find((s) => s.session_id === sessionId);
  const started = summary?.started ?? events[0]!.ts;
  const ended = summary?.ended ?? events[events.length - 1]!.ts;
  const cwd = events.find((e) => e.cwd)?.cwd ?? null;
  const agents = [...new Set(events.map((e) => e.agent_type).filter((a): a is string => !!a))];
  const actionCount = countActions(events);

  L.push(`- **Session:** \`${sessionId}\``);
  if (name) L.push(`- **Name:** ${name}`);
  L.push(`- **Project (cwd):** ${cwd ? `\`${cwd}\`` : '—'}`);
  L.push(`- **When:** ${started} → ${ended} (${formatDuration(started, ended)})`);
  L.push(`- **Events:** ${summary?.events ?? events.length} · **Actions:** ${actionCount}`);
  L.push(`- **Agent:** ${agents.length ? agents.join(', ') : 'unknown'}`);
  L.push('');

  // ── overall verdict + combos ──────────────────────────────────────────────
  const sr = store.sessionRisk(sessionId, rs);
  const verdict = sr?.verdict ?? 'unscored';
  const combos = safeParse<ComboFire[]>(sr?.combos ?? null, []);
  L.push(`## Overall verdict: ${verdict.toUpperCase()}${sr ? ` (score ${sr.score}/100)` : ''}`, '');
  L.push(sr ? `Scored under ruleset \`${sr.ruleset_version}\`.` : `Not yet scored — run \`blackbox rescore\`.`, '');
  if (combos.length) {
    L.push('Flagged combinations:', '');
    for (const c of combos) {
      const label = COMBO_LABEL[c.id] ?? c.id;
      L.push(`- **${c.severity.toUpperCase()} — ${label}:** ${c.note} _(seq ${c.antecedent_seq} → ${c.consequent_seq})_`);
    }
    L.push('');
  }

  // ── walk the persisted risk rows once: collect RISK-flagged actions (deduped
  //    across Pre/Post) and the distinct dangers across the whole session ───────
  const groups = new Map<string, { seq: number; e: BlackboxEvent; flags: Set<FlagId> }>();
  for (const r of store.riskForSession(sessionId, rs)) {
    const e = store.get(r.seq);
    if (!e) continue;
    const key = e.tool_use_id ?? `seq:${e.seq}`;
    const g = groups.get(key);
    const flags = safeParse<FlagId[]>(r.flags, []);
    if (g) for (const f of flags) g.flags.add(f);
    else groups.set(key, { seq: e.seq, e, flags: new Set(flags) }); // rows are seq-ascending, so this is the Pre
  }

  const flagged: FlaggedEntry[] = [];
  const checklist = new Map<string, string>(); // danger.what → danger.what (dedup by statement)
  for (const g of groups.values()) {
    const flags = [...g.flags];
    const ex = explainEvent(g.e, flags, toolInputOf(g.e.raw));
    for (const d of ex.dangers) checklist.set(d.what, d.what);
    const riskFlags = flags.filter((f) => RISK_FLAGS.has(f));
    if (riskFlags.length) flagged.push({ seq: g.seq, ts: g.e.ts, summary: ex.summary, flags: riskFlags, dangers: ex.dangers });
  }
  flagged.sort((a, b) => a.seq - b.seq);

  const clean = flagged.length === 0 && combos.length === 0;

  // ── flagged actions ───────────────────────────────────────────────────────
  L.push('## Flagged actions', '');
  if (clean) {
    L.push(`No risk flags — ${actionCount} action${actionCount === 1 ? '' : 's'} recorded.`, '');
  } else if (flagged.length === 0) {
    L.push('_No individually-flagged actions — the risk comes from the flagged combination above._', '');
  } else {
    for (const f of flagged) {
      L.push(`### ${HH_MM_SS(f.ts)} · ${f.summary}`, '');
      L.push(`Flags: ${f.flags.map((x) => `\`${x}\``).join(', ')}`, '');
      if (f.dangers.length) {
        L.push('Why this is risky:', '');
        for (const d of f.dangers) L.push(`- **${d.what}** ${d.why}`);
      } else {
        L.push(`- Flagged as ${f.flags.map((x) => `\`${x}\``).join(', ')} — review this action manually.`);
      }
      L.push('');
    }
  }

  // ── what to check (skipped on a genuinely clean session) ──────────────────
  if (!clean && checklist.size) {
    L.push('## What to check', '');
    for (const what of checklist.values()) L.push(`- [ ] ${what}`);
    L.push('');
  }

  return L.join('\n').replace(/\n+$/, '\n');
}

/** Default session for `blackbox report`: the highest-risk session, or the most
 *  recent when none is flagged (sessionCards is already sorted that way). Skips
 *  zero-activity sessions. Returns null when nothing has been recorded. */
export function defaultReportSession(store: Store): string | null {
  return sessionCards(store)[0]?.session_id ?? null;
}
