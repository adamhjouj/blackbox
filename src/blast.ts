/**
 * R8.1 — blast radius & containment (ARCHITECTURE §11). A PURE projector over one
 * session's immutable events + its re-derivable risk layer, producing the four
 * evidence buckets (files, secrets, external destinations, git artifacts) and an
 * ordered, severity-first CONTAINMENT CHECKLIST — each item linked to the exact
 * evidence seq(s). Deterministic; never writes.
 *
 * Honest scope (from the review): per-file commit membership isn't a stored fact
 * (diffstat is aggregate), so commits are listed as artifacts to review, not
 * attributed to individual files.
 */
import { safeParse } from './json';
import { projectFindings, type FindingOutcome } from './findings';
import type { ComboFire } from './risk-engine';
import { isSensitivePath } from './redact-rules';
import { KNOWN_RULESETS, commandReadsSensitiveFile, isAuthPath, rulesetNum } from './risk-rules';
import type { BlackboxEvent } from './types';
import type { Store } from './store';

/** The sensitive local file an event touches (mirrors risk-engine.sensitivePathTouched)
 *  — derived from the event, so a REDACTED read (whose risk hit carries no path) is
 *  still captured. */
function sensitivePathOf(e: BlackboxEvent): string | null {
  const t = e.target;
  if (!t) return null;
  if (/^file_(read|write|edit)$/.test(e.action_type)) return isSensitivePath(t) ? t : null;
  if (e.action_type === 'shell_command' || e.action_type === 'git_action') return commandReadsSensitiveFile(t);
  return null;
}

export type Severity = 'high' | 'medium' | 'low';

export interface ContainmentItem {
  order: number;
  severity: Severity;
  kind: 'rotate-secret' | 'revert-commit' | 'inspect-host' | 'review-file';
  action: string;
  /** evidence event seq(s) backing this item. */
  seqs: number[];
}

export interface BlastRadius {
  session_id: string;
  verdict: string;
  files: { path: string; insertions: number; deletions: number; auth: boolean; seqs: number[] }[];
  secrets: { path: string; seq: number }[];
  hosts: { host: string; via: string | null; seq: number; confirmed: boolean; correlated: boolean; outcome: FindingOutcome }[];
  commits: { sha: string; subject: string | null; seq: number; force: boolean }[];
  checklist: ContainmentItem[];
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function resolveRs(store: Store, sid: string): string {
  for (const rs of [...KNOWN_RULESETS].sort((a, b) => rulesetNum(b) - rulesetNum(a))) if (store.sessionRisk(sid, rs)) return rs;
  return KNOWN_RULESETS[KNOWN_RULESETS.length - 1]!;
}

export function blastRadius(store: Store, sessionId: string): BlastRadius {
  const rs = resolveRs(store, sessionId);
  const sr = store.sessionRisk(sessionId, rs);
  const verdict = sr?.verdict ?? 'none';
  const events = store.eventsLight(sessionId);
  const combos = projectFindings(events, safeParse<ComboFire[]>(sr?.combos ?? null) ?? []);
  const findingByHost = new Map(combos.filter((combo) => combo.host).map((combo) => [combo.host!, combo]));

  // ── B1 files + B4 git artifacts (from the immutable events) ───────────────
  const files = new Map<string, { path: string; insertions: number; deletions: number; auth: boolean; seqs: number[] }>();
  const commits: BlastRadius['commits'] = [];
  const secrets = new Map<string, number>();
  for (const e of events) {
    // B2 secrets — independent of detail (a shell `curl @/app/.env` carries none).
    const sp = sensitivePathOf(e);
    if (sp && !secrets.has(sp)) secrets.set(sp, e.seq);
    const d = safeParse<Record<string, unknown>>(e.detail);
    if (!d) continue;
    const mut = d.mutation as { diffstat?: { insertions?: number; deletions?: number } } | undefined;
    if (mut && e.target && (e.action_type === 'file_write' || e.action_type === 'file_edit')) {
      const f = files.get(e.target) ?? { path: e.target, insertions: 0, deletions: 0, auth: isAuthPath(e.target), seqs: [] };
      f.insertions += mut.diffstat?.insertions ?? 0;
      f.deletions += mut.diffstat?.deletions ?? 0;
      f.seqs.push(e.seq);
      files.set(e.target, f);
    }
    const git = d.git as { commit?: { sha?: string; subject?: string }; is_force?: boolean; is_delete?: boolean; new?: string } | undefined;
    if (git?.commit?.sha) commits.push({ sha: git.commit.sha, subject: git.commit.subject ?? null, seq: e.seq, force: !!git.is_force });
    else if (git && (git.is_force || git.is_delete)) commits.push({ sha: git.new ?? '(ref)', subject: git.is_delete ? '(branch delete)' : '(force update)', seq: e.seq, force: true });
  }

  // ── B3 external destinations (from the risk evidence) ─────────────────────
  const hosts = new Map<string, { via: string | null; seq: number }>();
  for (const rr of store.riskForSession(sessionId, rs)) {
    const ev = safeParse<Record<string, { host?: unknown; via?: unknown }>>(rr.evidence);
    if (!ev) continue;
    const host = ev['external-send']?.host;
    if (typeof host === 'string' && !hosts.has(host)) hosts.set(host, { via: typeof ev['external-send']!.via === 'string' ? (ev['external-send']!.via as string) : null, seq: rr.seq });
  }

  // ── the ordered containment checklist ─────────────────────────────────────
  const checklist: ContainmentItem[] = [];
  const anyReportedSend = combos.some((combo) => combo.outcome === 'succeeded' && (combo.id === 'exfil-chain' || combo.id === 'injected-exfil' || combo.id === 'tool-poisoning'));
  for (const [path, seq] of secrets) checklist.push({
    order: 0,
    severity: anyReportedSend ? 'high' : 'medium',
    kind: 'rotate-secret',
    action: anyReportedSend ? `Rotate the credential that may have been exposed via ${path}` : `Review whether ${path} was exposed; rotate its credentials if confirmed`,
    seqs: [seq],
  });
  for (const c of commits) checklist.push({ order: 0, severity: c.force ? 'high' : 'medium', kind: 'revert-commit', action: `${c.force ? 'Investigate/undo' : 'Review'} commit ${c.sha.slice(0, 10)}${c.subject ? ` — ${c.subject}` : ''}`, seqs: [c.seq] });
  for (const [host, info] of hosts) {
    const finding = findingByHost.get(host);
    const outcome = finding?.outcome ?? 'unknown';
    const wording = outcome === 'succeeded' ? 'tool-reported outbound transfer' : outcome === 'failed' ? 'failed outbound-transfer attempt' : outcome === 'attempted' ? 'outbound-transfer attempt' : 'outbound action with unknown outcome';
    checklist.push({ order: 0, severity: outcome === 'succeeded' ? 'high' : 'medium', kind: 'inspect-host', action: `Inspect the ${wording} to ${host}${info.via ? ` (via ${info.via})` : ''}${finding ? ' — correlated session finding' : ''}`, seqs: [info.seq] });
  }
  for (const f of files.values()) if (f.auth) checklist.push({ order: 0, severity: 'medium', kind: 'review-file', action: `Review the auth-path change to ${f.path} (+${f.insertions} −${f.deletions})`, seqs: f.seqs });

  checklist.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.seqs[0]! - b.seqs[0]!);
  checklist.forEach((it, i) => (it.order = i + 1));

  return {
    session_id: sessionId,
    verdict,
    files: [...files.values()],
    secrets: [...secrets.entries()].map(([path, seq]) => ({ path, seq })),
    hosts: [...hosts.entries()].map(([host, info]) => {
      const finding = findingByHost.get(host);
      return { host, via: info.via, seq: info.seq, confirmed: !!finding, correlated: !!finding, outcome: finding?.outcome ?? 'unknown' };
    }),
    commits,
    checklist,
  };
}
