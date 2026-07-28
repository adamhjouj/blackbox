/**
 * Intent divergence — the agent's STATED narrative joined against its OBSERVED
 * actions, per turn. A PURE, re-derivable interpretation like risk and
 * reconciliation: it never touches the chain, lives in the un-hashed
 * `session_intent` table, and is recomputable via `blackbox intent`.
 *
 * THE HONEST LIMIT THAT SHAPES THIS FILE. Claude Code stores `thinking` blocks with
 * an EMPTY `thinking` field — the real chain-of-thought is encrypted in the opaque
 * `signature` (see transcript.ts). So what we hold is NOT reasoning: it is the
 * assistant's stated TEXT for the turn, redacted and truncated to 4000 points. Every
 * finding here therefore means "the agent did not SAY it did this", never "the agent
 * hid its reasoning". Same discipline as reconcile.ts reporting ghosts as
 * UNATTRIBUTED: state what the record can support, and nothing beyond it.
 *
 * DELIBERATELY NOT RISK. daemon.ts does not risk-score reasoning (a secret quoted in
 * an explanation would seed spurious combo antecedents), and this layer keeps that
 * decision intact: it produces forensic findings only, feeds no combo, moves no
 * score, and needs no new ruleset id.
 *
 * FALSE POSITIVES ARE CONTROLLED BY REUSE, not by a new taxonomy. Only entities the
 * existing tuned rules already consider interesting can raise a finding —
 * isSensitivePath() / commandReadsSensitiveFile() from the redaction + risk rules,
 * and looksLikeHost() from the read layer. "Contacted an external host and never
 * said so" is evidence; "read utils.ts and never said so" is noise.
 */
import { safeParse } from './json';
import { looksLikeHost } from './read-api';
import { isSensitivePath } from './redact-rules';
import { commandReadsSensitiveFile } from './risk-rules';
import { RULESET_VERSION } from './risk-rules';
import type { Store } from './store';
import type { BlackboxEvent } from './types';

/** Keyed like risk/reconciliation so the finding set stays reproducible. */
export const INTENT_VERSION = 'v1';

/** normalize.ts truncate() appends this; a truncated narrative can't prove absence. */
const ELLIPSIS = '…';

export type DivergenceType = 'undisclosed_action' | 'unfulfilled_statement';
export type EntityKind = 'path' | 'host' | 'command' | 'mcp_server';

export interface Divergence {
  type: DivergenceType;
  kind: EntityKind;
  /** The path / host / command binary / server name the finding is about. */
  value: string;
  /** The turn this divergence belongs to. */
  prompt_id: string;
  /** The event that performed the undisclosed action (absent for unfulfilled). */
  seq?: number;
  note: string;
}

export interface IntentCoverage {
  /** false when no turn in the session captured a narrative → nothing analyzable. */
  reasoning_available: boolean;
  turns_analyzed: number;
  /** Turns with observed activity but no captured narrative — skipped, NOT findings. */
  turns_skipped: number;
  /** Turns whose narrative hit the 4000-point cap; absence is unprovable there. */
  turns_truncated: number;
  /**
   * CONSTANT, and deliberately part of the persisted record: Claude Code encrypts
   * thinking, so this layer only ever saw the agent's stated text. A reader must
   * never mistake these findings for chain-of-thought analysis.
   */
  thinking_encrypted: true;
}

export interface IntentAnalysis {
  findings: Divergence[];
  coverage: IntentCoverage;
}

interface Entity {
  kind: EntityKind;
  value: string;
  seq: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary match for short, distinctive needles (hosts, binaries, servers).
 *  The needle is escaped to a literal, so the pattern is linear — no ReDoS. */
function mentionsWord(text: string, needle: string): boolean {
  if (!needle || needle.length > 200) return false;
  return new RegExp('\\b' + escapeRe(needle) + '\\b', 'i').test(text);
}

/** A path counts as disclosed if the narrative names it in full OR by basename —
 *  agents write "I'll check the .env file", not an absolute path. */
function mentionsPath(text: string, path: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(path.toLowerCase())) return true;
  const base = path.split('/').pop();
  return !!base && base.length > 2 && lower.includes(base.toLowerCase());
}

/** The sensitive local file an event touches — mirrors blast.sensitivePathOf so the
 *  three layers agree on what "sensitive" means. */
function sensitivePathOf(e: BlackboxEvent): string | null {
  const t = e.target;
  if (!t) return null;
  if (/^file_(read|write|edit)$/.test(e.action_type)) return isSensitivePath(t) ? t : null;
  if (e.action_type === 'shell_command' || e.action_type === 'git_action') return commandReadsSensitiveFile(t);
  return null;
}

/** The risk-relevant entities an event touched. Hosts and dangerous commands come
 *  from the already-scored risk layer, so this never re-implements those rules. */
function observedOf(e: BlackboxEvent, risk: { flags: string[]; evidence: Record<string, { host?: unknown }> } | undefined): Entity[] {
  const out: Entity[] = [];
  const p = sensitivePathOf(e);
  if (p) out.push({ kind: 'path', value: p, seq: e.seq });
  const host = risk?.evidence['external-send']?.host;
  if (typeof host === 'string' && looksLikeHost(host)) out.push({ kind: 'host', value: host, seq: e.seq });
  if (risk?.flags.includes('dangerous-shell') && e.target) {
    const binary = e.target.trim().split(/\s+/)[0];
    if (binary) out.push({ kind: 'command', value: binary, seq: e.seq });
  }
  if (e.action_type === 'mcp_call' && e.tool_name?.startsWith('mcp__')) {
    const server = e.tool_name.split('__')[1];
    if (server) out.push({ kind: 'mcp_server', value: server, seq: e.seq });
  }
  return out;
}

/** Sensitive paths + hosts the narrative NAMES. Same predicates as the observed
 *  side, so the two sets are directly comparable. */
function statedOf(text: string): { paths: Set<string>; hosts: Set<string> } {
  const paths = new Set<string>();
  const hosts = new Set<string>();
  for (const raw of text.split(/[\s`"'()[\]{},;<>]+/)) {
    const tok = raw.replace(/^[.:]+|[.:,]+$/g, ''); // strip sentence punctuation, keep ".env"
    if (!tok || tok.length > 200) continue;
    if (isSensitivePath(tok)) paths.add(tok);
    else if (tok.includes('.') && !tok.includes('/') && looksLikeHost(tok)) hosts.add(tok);
  }
  return { paths, hosts };
}

/** Analyse one session. Pure — takes only what it reads from the store. */
export function analyzeIntent(store: Store, sessionId: string): IntentAnalysis {
  const events = store.eventsLight(sessionId);
  const risk = new Map<number, { flags: string[]; evidence: Record<string, { host?: unknown }> }>();
  for (const r of store.riskForSession(sessionId, RULESET_VERSION)) {
    risk.set(r.seq, { flags: safeParse<string[]>(r.flags, []), evidence: safeParse<Record<string, { host?: unknown }>>(r.evidence, {}) });
  }

  // Narrative per turn. Post/failure rows are skipped on the observed side so a
  // Pre/Post pair can't report the same entity twice.
  const narrative = new Map<string, string>();
  const observed = new Map<string, Entity[]>();
  for (const e of events) {
    if (e.phase === 'reasoning') {
      const text = safeParse<{ reasoning?: unknown }>(e.detail, {}).reasoning;
      if (e.prompt_id && typeof text === 'string' && text.trim()) narrative.set(e.prompt_id, text);
      continue;
    }
    if (!e.prompt_id || e.phase === 'post' || e.phase === 'failure') continue;
    const ents = observedOf(e, risk.get(e.seq));
    if (ents.length) observed.set(e.prompt_id, [...(observed.get(e.prompt_id) ?? []), ...ents]);
  }

  const findings: Divergence[] = [];
  let analyzed = 0;
  let skipped = 0;
  let truncated = 0;

  for (const [promptId, ents] of observed) {
    const text = narrative.get(promptId);
    if (!text) {
      skipped++; // no narrative → nothing to compare. NOT a finding.
      continue;
    }
    analyzed++;
    const isTruncated = text.endsWith(ELLIPSIS);
    if (isTruncated) truncated++;

    const seen = new Set<string>();
    for (const ent of ents) {
      const dedupe = ent.kind + ':' + ent.value;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const disclosed = ent.kind === 'path' ? mentionsPath(text, ent.value) : mentionsWord(text, ent.value);
      if (disclosed) continue;
      findings.push({
        type: 'undisclosed_action',
        kind: ent.kind,
        value: ent.value,
        prompt_id: promptId,
        seq: ent.seq,
        note:
          NOTE[ent.kind] +
          (isTruncated ? ' — the narrative was truncated at the capture cap, so the mention may be in the cut tail' : ''),
      });
    }

    // The reverse direction is weaker (an agent may state a plan and defer it), so
    // it is annotation-grade — and unprovable at all once the text was truncated.
    if (isTruncated) continue;
    const stated = statedOf(text);
    for (const p of stated.paths) {
      if (ents.some((e) => e.kind === 'path' && mentionsPath(p, e.value))) continue;
      findings.push({ type: 'unfulfilled_statement', kind: 'path', value: p, prompt_id: promptId, note: 'the narrative names this sensitive path, but no recorded action touched it' });
    }
    for (const h of stated.hosts) {
      if (ents.some((e) => e.kind === 'host' && e.value.toLowerCase() === h.toLowerCase())) continue;
      findings.push({ type: 'unfulfilled_statement', kind: 'host', value: h, prompt_id: promptId, note: 'the narrative names this host, but no recorded action reached it' });
    }
  }

  return {
    findings,
    coverage: { reasoning_available: narrative.size > 0, turns_analyzed: analyzed, turns_skipped: skipped, turns_truncated: truncated, thinking_encrypted: true },
  };
}

const NOTE: Record<EntityKind, string> = {
  path: 'the agent touched this sensitive path but never named it in its stated narrative for the turn',
  host: 'the agent reached this external host but never named it in its stated narrative for the turn',
  command: 'the agent ran this flagged command but never named it in its stated narrative for the turn',
  mcp_server: 'the agent called this MCP server but never named it in its stated narrative for the turn',
};

/** Compute + persist. Mirrors reconcile.persistReconciliation. */
export function persistIntent(store: Store, sessionId: string, nowIso: string): IntentAnalysis {
  const a = analyzeIntent(store, sessionId);
  const events = store.eventsLight(sessionId);
  store.intentUpsert({
    session_id: sessionId,
    intent_version: INTENT_VERSION,
    finding_count: a.findings.length,
    findings: JSON.stringify(a.findings),
    coverage: JSON.stringify(a.coverage),
    last_seq: events.length ? events[events.length - 1]!.seq : 0,
    computed_at: nowIso,
  });
  return a;
}
