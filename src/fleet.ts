/**
 * R8.3 — fleet overview. One re-derivable aggregation across ALL sessions for the
 * corpus-level view: the verdict mix, flag totals, busiest repos, the external
 * hosts reached (with first-seen), and the most-touched sensitive paths. Head-seq
 * cached (append-only store), pure read — no capture change.
 */
import { safeParse } from './json';
import { looksLikeHost, sessionCards } from './read-api';
import { KNOWN_RULESETS, rulesetNum } from './risk-rules';
import type { Store } from './store';

export interface FleetOverview {
  sessions: number;
  verdicts: Record<string, number>;
  /** sessions at verdict high|medium. */
  flagged: number;
  /** sessions with a recorder-tamper flag (anti-forensics). */
  anti_forensics: number;
  /** aggregate risk-flag counts across the corpus. */
  rule_counts: Record<string, number>;
  /** busiest project directories. */
  repos: { cwd: string; sessions: number }[];
  /** external egress hosts, with when each was first seen. */
  hosts: { host: string; first_seen: string }[];
  /** most-touched sensitive paths. */
  top_paths: { path: string; count: number }[];
  head_seq: number;
}

let cache: { head: number; fleet: FleetOverview } | null = null;

export function fleetOverview(store: Store): FleetOverview {
  const head = store.chainMeta()?.head_seq ?? 0;
  if (cache && cache.head === head) return cache.fleet;

  const cards = sessionCards(store);
  const verdicts: Record<string, number> = {};
  const rule_counts: Record<string, number> = {};
  const repoCounts = new Map<string, number>();
  let flagged = 0;
  let antiForensics = 0;
  for (const c of cards) {
    verdicts[c.verdict] = (verdicts[c.verdict] ?? 0) + 1;
    if (c.verdict === 'high' || c.verdict === 'medium') flagged++;
    for (const [k, v] of Object.entries(c.flags)) rule_counts[k] = (rule_counts[k] ?? 0) + v;
    if (c.flags['recorder-tamper']) antiForensics++;
    if (c.cwd) repoCounts.set(c.cwd, (repoCounts.get(c.cwd) ?? 0) + 1);
  }

  // Hosts + sensitive paths from the per-event risk evidence — scan each session at
  // its highest available ruleset (mirrors the cards merge).
  const rsBySession = new Map<string, string>();
  for (const rs of KNOWN_RULESETS) {
    for (const r of store.sessionRiskAll(rs)) {
      const prev = rsBySession.get(r.session_id);
      if (!prev || rulesetNum(rs) > rulesetNum(prev)) rsBySession.set(r.session_id, rs);
    }
  }
  const hostFirstSeq = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  for (const [sid, rs] of rsBySession) {
    for (const rr of store.riskForSession(sid, rs)) {
      const ev = safeParse<Record<string, { host?: unknown; path?: unknown }>>(rr.evidence);
      if (!ev) continue;
      const host = ev['external-send']?.host;
      if (typeof host === 'string' && looksLikeHost(host) && !hostFirstSeq.has(host)) hostFirstSeq.set(host, rr.seq);
      const p = ev['secret-touch']?.path;
      if (typeof p === 'string') pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
    }
  }
  const hosts = [...hostFirstSeq.entries()]
    .map(([host, seq]) => ({ host, first_seen: store.get(seq)?.ts ?? '' }))
    .sort((a, b) => (a.first_seen < b.first_seen ? -1 : 1));
  const top_paths = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([path, count]) => ({ path, count }));
  const repos = [...repoCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([cwd, sessions]) => ({ cwd, sessions }));

  const fleet: FleetOverview = { sessions: cards.length, verdicts, flagged, anti_forensics: antiForensics, rule_counts, repos, hosts, top_paths, head_seq: head };
  cache = { head, fleet };
  return fleet;
}
