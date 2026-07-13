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
import type { AnchorReceipt } from './anchor';
import { explainEvent, type Danger } from './explain';
import { hashString } from './hash';
import { sessionCards, sessionStory } from './read-api';
import { redactText } from './redact';
import { sessionTitleFromTranscript } from './transcript';
import type { ComboFire } from './risk-engine';
import { KNOWN_RULESETS, RISK_FLAGS, RULESET_VERSION, rulesetNum, type FlagId, type RulesetVersion } from './risk-rules';
import type { Store } from './store';
import type { Watermark } from './sign';
import { verify } from './verify';
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
  for (const rs of [...KNOWN_RULESETS].sort((a, b) => rulesetNum(b) - rulesetNum(a))) {
    if (store.sessionRisk(sessionId, rs)) return rs;
  }
  return RULESET_VERSION;
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
  'anti-forensics': 'Anti-forensics (recorder tampered with)',
};

// Human-readable session name: the user's /rename (customTitle), else the AI title
// (aiTitle), via the same bounded tail read read-api uses (never the whole file).
function sessionName(store: Store, sessionId: string): string | null {
  const tp = store.sessionTranscriptPath(sessionId);
  return tp ? sessionTitleFromTranscript(tp) : null;
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
  const rawName = sessionName(store, sessionId);
  const name = rawName ? redactText(rawName).text : null; // the transcript name could carry a secret
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

/** Short fingerprint of a PEM public key — a stable, human-comparable id. */
function keyFingerprint(pem: string): string {
  return hashString(pem).replace('sha256:', '').slice(0, 16);
}

export interface ForensicOptions {
  ruleset?: RulesetVersion;
  /** Trusted Ed25519 public key (PEM) — enables the signed-checkpoint verification. */
  trustedPublicKey?: string | null;
  /** Out-of-DB high-watermark — enables the anti-deletion check. */
  watermark?: Watermark | null;
  /** R6 external anchor receipts — enables the off-machine rewrite-proof check. */
  anchors?: AnchorReceipt[] | null;
  /** Human label for where the anchors came from (e.g. "file ~/anchors.jsonl"). */
  anchorLabel?: string | null;
  /** Wall-clock stamp (ISO); passed in so the case-file is deterministic in tests. */
  generatedAt?: string;
}

/**
 * R3 forensic case-file — a self-contained evidentiary bundle: chain-of-custody
 * (verify() status + head hash + the covering signature), the plain-English risk
 * report, the provenance story (what changed), and a SHA-256 manifest of the whole
 * document so the file itself is tamper-evident. Pure read-time projection; never
 * writes, never touches the chain.
 */
export function buildForensicReport(store: Store, sessionId: string, opts: ForensicOptions = {}): string {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const anchors = opts.anchors ?? [];
  const v = verify(store, { trustedPublicKey: opts.trustedPublicKey, watermark: opts.watermark, anchors });
  const meta = store.chainMeta();
  const sig = store.latestSignature();
  // Redact the session name — it's read raw from the transcript and could carry a secret.
  const rawName = sessionName(store, sessionId);
  const name = rawName ? redactText(rawName).text : null;
  const L: string[] = [];

  L.push(`# Blackbox forensic case-file — ${name ?? sessionId}`, '', `_Generated ${generatedAt}_`, '');

  // ── chain of custody ──────────────────────────────────────────────────────
  L.push('## Chain of custody', '');
  L.push(
    v.ok
      ? `- **Integrity:** ✓ verified — the recorded chain is internally consistent`
      : `- **Integrity:** ✗ BROKEN at seq ${v.break!.seq} (${v.break!.reason}) — ${v.break!.detail}`,
  );
  L.push(`- **Scope:** ${v.count} event(s) across ${v.sessions} session(s)`);
  if (meta) L.push(`- **Head:** seq ${meta.head_seq} · \`${meta.head_hash}\``);
  if (sig) {
    const covers = !!meta && sig.seq === meta.head_seq && sig.head_hash === meta.head_hash;
    const checked = opts.trustedPublicKey
      ? v.ok
        ? 'verifies under the trusted key'
        : 'FAILED verification under the trusted key'
      : 'present but not checked (no trusted key supplied)';
    L.push(`- **Signature:** Ed25519 checkpoint at seq ${sig.seq}, signed ${sig.ts} — ${checked}${covers ? '' : ' (does not cover the current head)'}`);
    L.push(`  - key fingerprint: \`${keyFingerprint(sig.pubkey)}\``);
  } else {
    L.push(`- **Signature:** none — this store was never keyed (\`blackbox init\` generates the key; the daemon signs at session boundaries).`);
  }
  // ── external anchors (R6) ─────────────────────────────────────────────────
  if (anchors.length) {
    const seqs = anchors.map((a) => a.seq).sort((x, y) => x - y);
    const anchorOk = v.ok || v.break!.reason !== 'anchor-mismatch';
    L.push(
      `- **External anchors:** ${anchors.length} signed head receipt(s)${opts.anchorLabel ? ` from ${opts.anchorLabel}` : ''}, covering seq ${seqs[0]}–${seqs[seqs.length - 1]} — ` +
        (opts.trustedPublicKey
          ? anchorOk
            ? 'all match the chain under the trusted key (no off-machine-witnessed rewrite)'
            : `**MISMATCH** — an off-machine receipt no longer matches the chain: ${v.break!.detail}`
          : 'present but not checked (no trusted key supplied)'),
    );
    L.push(
      `- **Honest limit:** the internal chain + local signing prove tamper-*evidence*; these external receipts add tamper-*resistance* a full-\`~/.blackbox\` attacker can't forge, because a receipt off the machine can't be re-signed. Any surviving receipt that no longer matches PROVES a rewrite.`,
      '',
    );
  } else {
    L.push(
      `- **Honest limit:** signing is local. Detected: wrong-key re-signing, content alteration at/below a signed head, and signature deletion/rollback (via the out-of-DB \`signing.head\` watermark). NOT resisted: an attacker with full \`~/.blackbox\` write access (DB + key + watermark) can re-sign — **true** off-machine resistance is external anchoring (\`blackbox anchor --to …\`, R6): signed head receipts placed where that attacker can't reach.`,
      '',
    );
  }

  // ── the plain-English risk report (its own H1 dropped) ────────────────────
  const rep = buildReport(store, sessionId, opts.ruleset);
  L.push(rep.startsWith('# ') ? rep.slice(rep.indexOf('\n') + 1).replace(/^\n+/, '') : rep);

  // ── provenance — what changed ─────────────────────────────────────────────
  const story = sessionStory(store, sessionId);
  L.push('## Provenance — what changed', '');
  if (story.files_changed.length) {
    L.push('Files changed:', '');
    for (const f of story.files_changed) L.push(`- \`${f.path}\` (+${f.insertions} −${f.deletions})`);
    L.push('');
  } else {
    L.push('No file mutations recorded.', '');
  }
  if (story.commits.length) {
    L.push('Commits:', '');
    for (const c of story.commits) L.push(`- \`${(c.sha ?? '').slice(0, 7)}\` ${c.subject ?? ''}`.trimEnd());
    L.push('');
  }

  // ── manifest: the case-file is itself tamper-evident ──────────────────────
  const body = L.join('\n').replace(/\n+$/, '');
  const manifest = hashString(body);
  return `${body}\n\n---\n**Manifest (sha-256 of everything above this line):** \`${manifest}\`\n`;
}
