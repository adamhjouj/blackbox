import { basename } from 'node:path';
import { loadBaselinePolicy, type LoadedBaselinePolicy } from './baseline';
import { resolveRepoTop } from './git-collector';
import { hashString } from './hash';
import { safeParse } from './json';
import { deriveReviewFindings, reviewIsStale, type ReviewDisposition, type ReviewFinding } from './review';
import { KNOWN_RULESETS } from './risk-rules';
import type { ComboFire } from './risk-engine';
import { sessionName } from './read-api';
import type { ReviewActionRow, SessionRiskRow, Store } from './store';
import type { BlackboxEvent } from './types';

export interface ReviewFindingState extends ReviewFinding {
  disposition: ReviewDisposition;
  stale: boolean;
  resolved: boolean;
  review: ReviewActionRow | null;
}

export interface SessionReviewView {
  session_id: string;
  title: string;
  project: string;
  cwd: string | null;
  branch: string | null;
  commit: string | null;
  started: string;
  ended: string;
  verdict: string;
  score: number;
  ruleset_version: string | null;
  policy_hash: string | null;
  baseline_error: string | null;
  last_seq: number;
  last_hash: string;
  total: number;
  unresolved: number;
  stale: number;
  expected: number;
  findings: ReviewFindingState[];
}

function newestRisk(store: Store, sessionId: string): SessionRiskRow | null {
  for (const ruleset of [...KNOWN_RULESETS].reverse()) {
    const row = store.sessionRisk(sessionId, ruleset);
    if (row) return row;
  }
  return null;
}

function anchorFrom(events: readonly BlackboxEvent[]): { branch: string | null; commit: string | null } {
  for (const event of events) {
    const anchor = safeParse<{ anchor?: { branch?: unknown; head_sha?: unknown } }>(event.detail, {}).anchor;
    if (!anchor) continue;
    return {
      branch: typeof anchor.branch === 'string' ? anchor.branch : null,
      commit: typeof anchor.head_sha === 'string' ? anchor.head_sha : null,
    };
  }
  return { branch: null, commit: null };
}

const repoRootCache = new Map<string, string>();

function loadProjectBaseline(events: readonly BlackboxEvent[]): { baseline: LoadedBaselinePolicy | null; error: string | null; cwd: string | null; root: string | null } {
  const cwd = events.find((event) => event.cwd)?.cwd ?? null;
  if (!cwd) return { baseline: null, error: null, cwd: null, root: null };
  let root = repoRootCache.get(cwd);
  if (!root) {
    root = resolveRepoTop(cwd) ?? cwd;
    if (repoRootCache.size > 4096) repoRootCache.clear();
    repoRootCache.set(cwd, root);
  }
  try { return { baseline: loadBaselinePolicy(root), error: null, cwd, root }; }
  catch (err) { return { baseline: null, error: (err as Error).message, cwd, root }; }
}

function latestReviews(rows: readonly ReviewActionRow[]): Map<string, ReviewActionRow> {
  const latest = new Map<string, ReviewActionRow>();
  for (const row of rows) latest.set(row.finding_key, row);
  return latest;
}

export function sessionReviewView(store: Store, sessionId: string): SessionReviewView | null {
  const events = store.eventsLight(sessionId);
  if (!events.length) return null;
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const risk = newestRisk(store, sessionId);
  const baselineState = loadProjectBaseline(events);
  // A malformed/unreadable policy is a distinct fail-closed state, not the same
  // thing as "no policy". Its content never enters the UI or review ledger; this
  // stable error fingerprint exists only to invalidate decisions made under a
  // different policy state.
  const policyHash = baselineState.baseline?.hash ?? (baselineState.error
    ? hashString(`blackbox-baseline-error-v1\n${baselineState.error}`)
    : null);
  const combos = risk ? safeParse<ComboFire[]>(risk.combos, []) : [];
  const risks = risk
    ? store.riskForSession(sessionId, risk.ruleset_version).map((row) => ({
        seq: row.seq,
        score: row.score,
        flags: safeParse<string[]>(row.flags, []),
        evidence: safeParse<Record<string, unknown> | null>(row.evidence, null),
      }))
    : [];
  const projected = risk
    ? deriveReviewFindings({
        session_id: sessionId,
        ruleset_version: risk.ruleset_version,
        events,
        combos,
        risks,
        baseline: baselineState.baseline,
      })
    : [];
  const reviews = latestReviews(store.reviewsForSession(sessionId));
  const findings: ReviewFindingState[] = projected.map((finding) => {
    const review = reviews.get(finding.key) ?? null;
    const stale = review
      ? baselineState.error !== null || reviewIsStale(review, { last_seq: last.seq, last_hash: last.hash, policy_hash: policyHash })
      : false;
    const disposition: ReviewDisposition = review && !stale && !baselineState.error ? review.disposition : 'unreviewed';
    return { ...finding, policy_hash: policyHash, review, disposition, stale, resolved: disposition !== 'unreviewed' };
  });
  const anchor = anchorFrom(events);
  const cwd = baselineState.cwd;
  return {
    session_id: sessionId,
    title: sessionName(store, sessionId) ?? `Session ${sessionId.slice(0, 12)}`,
    project: baselineState.root ? basename(baselineState.root) || baselineState.root : cwd ? basename(cwd) || cwd : 'No project',
    cwd,
    branch: anchor.branch,
    commit: anchor.commit,
    started: first.ts,
    ended: last.ts,
    verdict: risk?.verdict ?? 'unscored',
    score: risk?.score ?? 0,
    ruleset_version: risk?.ruleset_version ?? null,
    policy_hash: policyHash,
    baseline_error: baselineState.error,
    last_seq: last.seq,
    last_hash: last.hash,
    total: findings.length,
    unresolved: findings.filter((finding) => !finding.resolved).length,
    stale: findings.filter((finding) => finding.stale).length,
    expected: findings.filter((finding) => finding.expected).length,
    findings,
  };
}

export function reviewViews(store: Store): SessionReviewView[] {
  return store
    .sessions()
    .filter((session) => session.activity > 0 && !session.session_id.startsWith('bb:'))
    .map((session) => sessionReviewView(store, session.session_id))
    .filter((session): session is SessionReviewView => !!session);
}

export function reviewInboxFromViews(views: readonly SessionReviewView[]): SessionReviewView[] {
  return views
    .filter((session) => session.unresolved > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.ended) - Date.parse(a.ended));
}

export function reviewInbox(store: Store): SessionReviewView[] {
  return reviewInboxFromViews(reviewViews(store));
}
