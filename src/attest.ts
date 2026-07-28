/**
 * Privacy-safe, portable session attestations.
 *
 * An attestation is a signed projection of an already-recorded session. It never
 * enters or mutates the evidence chain, and its payload is intentionally built
 * from a closed metadata allowlist. Raw hook bytes, prompts, commands, paths,
 * hosts, session names, review notes, and working directories are never copied.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { keyFingerprint } from './anchor';
import { loadBaselinePolicy } from './baseline';
import { resolveRepoTop } from './git-collector';
import { canonical } from './hash';
import { RECON_VERSION, type Completeness, type Coverage } from './reconcile';
import {
  deriveReviewFindings,
  reviewIsStale,
  type ReviewDisposition,
  type ReviewFinding,
} from './review';
import { computeSession } from './risk-engine';
import { isKnownRuleset, RULESET_VERSION, rulesFingerprint, type RulesetVersion } from './risk-rules';
import { recorderId, type Keypair, type Watermark } from './sign';
import type { ReviewActionRow, Store } from './store';
import type { EventSource } from './types';
import { verify } from './verify';

export const SESSION_ATTESTATION_FORMAT = 'blackbox-session-attestation' as const;
export const SESSION_ATTESTATION_VERSION = 1 as const;
export const SESSION_ATTESTATION_DOMAIN = 'blackbox-session-attestation-v1\n';

type Severity = 'high' | 'medium' | 'low';
type Outcome = 'attempted' | 'succeeded' | 'failed' | 'unknown';
type AgentSource = Extract<EventSource, 'claude-code' | 'gemini-cli'>;
type ReviewStatus = 'clear' | 'needs_review' | 'reviewed';

export interface CountBySeverity {
  high: number;
  medium: number;
  low: number;
}

export interface CountByOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  unknown: number;
}

export interface CountByDisposition {
  unreviewed: number;
  acknowledged: number;
  expected: number;
  false_positive: number;
}

export interface ReconciliationCoverageAttestation {
  corroborated: boolean;
  files_on_disk: number;
  hook_files: number;
  truncated: boolean;
  completeness: {
    transcript_tool_uses: number;
    recorded: number;
    missing: number;
    unexplained_missing: number;
    coverage_ratio: number;
  } | null;
}

export interface SessionAttestationPayloadV1 {
  session_id: string;
  evidence: {
    first_seq: number;
    last_seq: number;
    last_hash: string;
    event_count: number;
  };
  revision?: {
    commit?: string;
    branch?: string;
  };
  recorder: {
    id: string;
    key_fingerprint: string;
  };
  agent_sources: AgentSource[];
  assessment: {
    ruleset: RulesetVersion;
    rules_hash: string;
    verdict: 'none' | 'low' | 'medium' | 'high';
    score: number;
    findings: {
      total: number;
      severity: CountBySeverity;
      outcome: CountByOutcome;
    };
  };
  review: {
    status: ReviewStatus;
    total: number;
    unresolved: number;
    stale: number;
    dispositions: CountByDisposition;
    unresolved_by_severity: CountBySeverity;
    policy_hash: string | null;
  };
  reconciliation_coverage: ReconciliationCoverageAttestation | null;
  issued_at: string;
}

export interface SessionAttestationEnvelopeV1 {
  format: typeof SESSION_ATTESTATION_FORMAT;
  version: typeof SESSION_ATTESTATION_VERSION;
  payload: SessionAttestationPayloadV1;
  public_key: string;
  signature: string;
}

export interface CreateSessionAttestationOptions {
  /** Optional local anti-deletion watermark. When supplied it must validate. */
  watermark?: Watermark | null;
  /** Injectable canonical ISO timestamp for deterministic tests/callers. */
  issuedAt?: string;
  /** Explicit revision values override a captured SessionStart git anchor. */
  commit?: string | null;
  branch?: string | null;
}

export class SessionAttestationError extends Error {
  constructor(
    public readonly code:
      | 'chain-invalid'
      | 'invalid-keypair'
      | 'invalid-metadata'
      | 'session-missing'
      | 'session-changed',
    message: string,
  ) {
    super(message);
    this.name = 'SessionAttestationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function subsetKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function canonicalIso(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeCommit(value: string | null | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(normalized)) {
    throw new SessionAttestationError('invalid-metadata', 'attestation commit must be a 7-64 character hexadecimal object id');
  }
  return normalized;
}

function normalizeBranch(value: string | null | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SessionAttestationError('invalid-metadata', 'attestation branch must be 1-255 characters without control characters');
  }
  return normalized;
}

function samePublicKey(a: string, b: string): boolean {
  try {
    const aDer = createPublicKey(a).export({ type: 'spki', format: 'der' });
    const bDer = createPublicKey(b).export({ type: 'spki', format: 'der' });
    return aDer.equals(bDer);
  } catch {
    return false;
  }
}

function assertKeypair(keys: Keypair): void {
  try {
    const privateKey = createPrivateKey(keys.privateKeyPem);
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const suppliedKey = createPublicKey(keys.publicKeyPem);
    if (suppliedKey.asymmetricKeyType !== 'ed25519') throw new Error('public key is not Ed25519');
    const supplied = suppliedKey.export({ type: 'spki', format: 'der' });
    if (!derived.equals(supplied)) throw new Error('public key does not match private key');
  } catch (error) {
    throw new SessionAttestationError('invalid-keypair', `cannot create attestation: ${(error as Error).message}`);
  }
}

/** Exact, domain-separated bytes signed by every v1 attestation. */
export function sessionAttestationMessage(payload: SessionAttestationPayloadV1): Buffer {
  return Buffer.from(SESSION_ATTESTATION_DOMAIN + canonical(payload), 'utf8');
}

function capturedRevision(events: ReturnType<Store['eventsLight']>): { commit?: string; branch?: string } {
  let captured: { commit?: string; branch?: string } = {};
  for (const event of events) {
    if (!event.detail) continue;
    try {
      const detail = JSON.parse(event.detail) as unknown;
      if (!isRecord(detail) || !isRecord(detail.anchor)) continue;
      const commit = typeof detail.anchor.head_sha === 'string' ? normalizeCommit(detail.anchor.head_sha) : undefined;
      const branch = typeof detail.anchor.branch === 'string' ? normalizeBranch(detail.anchor.branch) : undefined;
      captured = { ...(commit ? { commit } : {}), ...(branch ? { branch } : {}) };
    } catch (error) {
      if (error instanceof SessionAttestationError) throw error;
      // A malformed unrelated detail bag is ignored. The chain verifier already
      // checks its immutable bytes; it simply cannot contribute revision metadata.
    }
  }
  // SessionEnd is captured after the agent's work, so the last anchor is the
  // honest revision candidate for a pre-merge attestation. Older sessions that
  // only carry SessionStart remain supported.
  return captured;
}

function currentBaseline(events: ReturnType<Store['eventsLight']>) {
  const cwd = events.find((event) => event.cwd)?.cwd;
  if (!cwd) return null;
  const root = resolveRepoTop(cwd) ?? cwd;
  try {
    return loadBaselinePolicy(root);
  } catch (error) {
    throw new SessionAttestationError(
      'invalid-metadata',
      `cannot attest review state because the project baseline is invalid: ${(error as Error).message}`,
    );
  }
}

function latestReviews(rows: readonly ReviewActionRow[]): Map<string, ReviewActionRow> {
  const latest = new Map<string, ReviewActionRow>();
  for (const row of rows) latest.set(row.finding_key, row);
  return latest;
}

function emptySeverity(): CountBySeverity {
  return { high: 0, medium: 0, low: 0 };
}

function emptyOutcome(): CountByOutcome {
  return { attempted: 0, succeeded: 0, failed: 0, unknown: 0 };
}

function emptyDisposition(): CountByDisposition {
  return { unreviewed: 0, acknowledged: 0, expected: 0, false_positive: 0 };
}

function aggregateReview(
  store: Store,
  sessionId: string,
  findings: readonly ReviewFinding[],
  head: { seq: number; hash: string },
  policyHash: string | null,
): SessionAttestationPayloadV1['review'] {
  const latest = latestReviews(store.reviewsForSession(sessionId));
  const dispositions = emptyDisposition();
  const unresolvedBySeverity = emptySeverity();
  let stale = 0;

  for (const finding of findings) {
    const row = latest.get(finding.key);
    const isStale = row
      ? reviewIsStale(row, {
          last_seq: head.seq,
          last_hash: head.hash,
          policy_hash: finding.policy_hash,
        })
      : false;
    if (isStale) stale += 1;
    const disposition: ReviewDisposition = row && !isStale ? row.disposition : 'unreviewed';
    dispositions[disposition] += 1;
    if (disposition === 'unreviewed') unresolvedBySeverity[finding.severity] += 1;
  }

  const unresolved = dispositions.unreviewed;
  const status: ReviewStatus = findings.length === 0 ? 'clear' : unresolved > 0 ? 'needs_review' : 'reviewed';
  return {
    status,
    total: findings.length,
    unresolved,
    stale,
    dispositions,
    unresolved_by_severity: unresolvedBySeverity,
    policy_hash: policyHash,
  };
}

function aggregateFindings(findings: readonly ReviewFinding[]): SessionAttestationPayloadV1['assessment']['findings'] {
  const severity = emptySeverity();
  const outcome = emptyOutcome();
  for (const finding of findings) {
    severity[finding.severity] += 1;
    outcome[finding.outcome] += 1;
  }
  return { total: findings.length, severity, outcome };
}

function finiteRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function projectCompleteness(value: Completeness | null | undefined): ReconciliationCoverageAttestation['completeness'] {
  if (value == null) return null;
  if (
    !isNonNegativeInteger(value.transcript_tool_uses) ||
    !isNonNegativeInteger(value.recorded) ||
    !Array.isArray(value.missing) ||
    !finiteRatio(value.coverage_ratio)
  ) {
    throw new SessionAttestationError('invalid-metadata', 'stored reconciliation completeness is malformed');
  }
  const unexplained = value.missing.filter((item) => item?.explained === 'unexplained').length;
  return {
    transcript_tool_uses: value.transcript_tool_uses,
    recorded: value.recorded,
    missing: value.missing.length,
    unexplained_missing: unexplained,
    coverage_ratio: value.coverage_ratio,
  };
}

function reconciliationCoverage(
  store: Store,
  sessionId: string,
  lastSeq: number,
): ReconciliationCoverageAttestation | null {
  const row = store.sessionReconciliation(sessionId, RECON_VERSION);
  if (!row || row.last_seq !== lastSeq) return null;
  try {
    const value = JSON.parse(row.coverage) as Coverage;
    if (
      !isRecord(value) ||
      typeof value.corroborated !== 'boolean' ||
      !isNonNegativeInteger(value.files_on_disk) ||
      !isNonNegativeInteger(value.hook_files) ||
      typeof value.truncated !== 'boolean'
    ) {
      throw new Error('invalid aggregate fields');
    }
    return {
      corroborated: value.corroborated,
      files_on_disk: value.files_on_disk,
      hook_files: value.hook_files,
      truncated: value.truncated,
      completeness: projectCompleteness(value.completeness),
    };
  } catch (error) {
    if (error instanceof SessionAttestationError) throw error;
    throw new SessionAttestationError(
      'invalid-metadata',
      `stored reconciliation coverage is malformed: ${(error as Error).message}`,
    );
  }
}

function currentProjection(store: Store, sessionId: string, events: ReturnType<Store['eventsLight']>) {
  const current = computeSession(store, sessionId, RULESET_VERSION);
  const baseline = currentBaseline(events);
  const findings = deriveReviewFindings({
    session_id: sessionId,
    ruleset_version: RULESET_VERSION,
    events,
    combos: current.verdict.combos,
    risks: current.risks,
    baseline,
  });
  return { current, baseline, findings };
}

/**
 * Create a v1 session attestation without writing to the evidence or derived
 * tables. The current ruleset is replayed in memory, so an absent/stale stored
 * verdict can never be signed as if it described the current session head.
 */
function createSessionAttestationSnapshot(
  store: Store,
  sessionId: string,
  keys: Keypair,
  options: CreateSessionAttestationOptions = {},
): SessionAttestationEnvelopeV1 {
  if (!safeSessionId(sessionId)) {
    throw new SessionAttestationError('invalid-metadata', 'attestation session id is invalid');
  }
  assertKeypair(keys);

  const integrity = verify(store, {
    trustedPublicKey: keys.publicKeyPem,
    watermark: options.watermark ?? null,
  });
  if (!integrity.ok) {
    const reason = integrity.break ? `${integrity.break.reason} at seq ${integrity.break.seq}` : 'unknown break';
    throw new SessionAttestationError('chain-invalid', `refusing attestation because evidence verification failed: ${reason}`);
  }

  const events = store.eventsLight(sessionId);
  if (!events.length) {
    throw new SessionAttestationError('session-missing', `cannot attest missing or empty session ${sessionId}`);
  }
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const projection = currentProjection(store, sessionId, events);
  const captured = capturedRevision(events);
  const commit = options.commit === undefined ? captured.commit : normalizeCommit(options.commit);
  const branch = options.branch === undefined ? captured.branch : normalizeBranch(options.branch);
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  if (!canonicalIso(issuedAt)) {
    throw new SessionAttestationError('invalid-metadata', 'attestation issuedAt must be a canonical ISO-8601 timestamp');
  }

  const sources = [...new Set(events.map((event) => event.source))]
    .filter((source): source is AgentSource => source === 'claude-code' || source === 'gemini-cli')
    .sort();
  const findings = aggregateFindings(projection.findings);
  const review = aggregateReview(
    store,
    sessionId,
    projection.findings,
    { seq: last.seq, hash: last.hash },
    projection.baseline?.hash ?? null,
  );
  const revision =
    commit || branch
      ? { ...(commit ? { commit } : {}), ...(branch ? { branch } : {}) }
      : undefined;
  const payload: SessionAttestationPayloadV1 = {
    session_id: sessionId,
    evidence: {
      first_seq: first.seq,
      last_seq: last.seq,
      last_hash: last.hash,
      event_count: events.length,
    },
    ...(revision ? { revision } : {}),
    recorder: {
      id: recorderId(keys.publicKeyPem),
      key_fingerprint: keyFingerprint(keys.publicKeyPem),
    },
    agent_sources: sources,
    assessment: {
      ruleset: RULESET_VERSION,
      rules_hash: rulesFingerprint(RULESET_VERSION),
      verdict: projection.current.verdict.verdict,
      score: projection.current.verdict.score,
      findings,
    },
    review,
    reconciliation_coverage: reconciliationCoverage(store, sessionId, last.seq),
    issued_at: issuedAt,
  };

  // Detect a writer extending this same session while the projection was built.
  const finalEvents = store.eventsLight(sessionId);
  const finalLast = finalEvents[finalEvents.length - 1];
  if (
    finalEvents.length !== events.length ||
    finalLast?.seq !== last.seq ||
    finalLast.hash !== last.hash
  ) {
    throw new SessionAttestationError('session-changed', 'session changed while the attestation was being built; retry');
  }
  const finalIntegrity = verify(store, {
    trustedPublicKey: keys.publicKeyPem,
    watermark: options.watermark ?? null,
  });
  if (!finalIntegrity.ok) {
    throw new SessionAttestationError('chain-invalid', 'refusing attestation because evidence verification changed during generation');
  }
  const finalBaseline = currentBaseline(events);
  if ((projection.baseline?.hash ?? null) !== (finalBaseline?.hash ?? null)) {
    throw new SessionAttestationError('session-changed', 'baseline policy changed while the attestation was being built; retry');
  }

  return {
    format: SESSION_ATTESTATION_FORMAT,
    version: SESSION_ATTESTATION_VERSION,
    payload,
    public_key: keys.publicKeyPem,
    signature: cryptoSign(null, sessionAttestationMessage(payload), keys.privateKeyPem).toString('base64'),
  };
}

export function createSessionAttestation(
  store: Store,
  sessionId: string,
  keys: Keypair,
  options: CreateSessionAttestationOptions = {},
): SessionAttestationEnvelopeV1 {
  return store.readSnapshot(() => createSessionAttestationSnapshot(store, sessionId, keys, options));
}

function validSeverityCounts(value: unknown): value is CountBySeverity {
  return (
    isRecord(value) &&
    exactKeys(value, ['high', 'medium', 'low']) &&
    isNonNegativeInteger(value.high) &&
    isNonNegativeInteger(value.medium) &&
    isNonNegativeInteger(value.low)
  );
}

function validOutcomeCounts(value: unknown): value is CountByOutcome {
  return (
    isRecord(value) &&
    exactKeys(value, ['attempted', 'succeeded', 'failed', 'unknown']) &&
    isNonNegativeInteger(value.attempted) &&
    isNonNegativeInteger(value.succeeded) &&
    isNonNegativeInteger(value.failed) &&
    isNonNegativeInteger(value.unknown)
  );
}

function validDispositionCounts(value: unknown): value is CountByDisposition {
  return (
    isRecord(value) &&
    exactKeys(value, ['unreviewed', 'acknowledged', 'expected', 'false_positive']) &&
    isNonNegativeInteger(value.unreviewed) &&
    isNonNegativeInteger(value.acknowledged) &&
    isNonNegativeInteger(value.expected) &&
    isNonNegativeInteger(value.false_positive)
  );
}

function validCompleteness(value: unknown): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !exactKeys(value, ['transcript_tool_uses', 'recorded', 'missing', 'unexplained_missing', 'coverage_ratio']) ||
    !isNonNegativeInteger(value.transcript_tool_uses) ||
    !isNonNegativeInteger(value.recorded) ||
    !isNonNegativeInteger(value.missing) ||
    !isNonNegativeInteger(value.unexplained_missing) ||
    !finiteRatio(value.coverage_ratio)
  ) return false;
  const expectedRatio = value.transcript_tool_uses === 0 ? 1 : value.recorded / value.transcript_tool_uses;
  return (
    value.recorded + value.missing === value.transcript_tool_uses &&
    value.unexplained_missing <= value.missing &&
    Math.abs(value.coverage_ratio - expectedRatio) <= Number.EPSILON * 8
  );
}

function validReconciliation(value: unknown): value is ReconciliationCoverageAttestation | null {
  return (
    value === null ||
    (isRecord(value) &&
      exactKeys(value, ['corroborated', 'files_on_disk', 'hook_files', 'truncated', 'completeness']) &&
      typeof value.corroborated === 'boolean' &&
      isNonNegativeInteger(value.files_on_disk) &&
      isNonNegativeInteger(value.hook_files) &&
      typeof value.truncated === 'boolean' &&
      validCompleteness(value.completeness))
  );
}

function parseEnvelope(input: string | unknown): SessionAttestationEnvelopeV1 {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new Error('invalid JSON');
    }
  }
  if (!isRecord(value) || !exactKeys(value, ['format', 'version', 'payload', 'public_key', 'signature'])) {
    throw new Error('invalid envelope fields');
  }
  if (value.format !== SESSION_ATTESTATION_FORMAT || value.version !== SESSION_ATTESTATION_VERSION) {
    throw new Error('unsupported attestation format or version');
  }
  if (typeof value.public_key !== 'string' || typeof value.signature !== 'string') {
    throw new Error('invalid cryptographic fields');
  }
  const payload = value.payload;
  if (
    !isRecord(payload) ||
    !subsetKeys(payload, [
      'session_id',
      'evidence',
      'revision',
      'recorder',
      'agent_sources',
      'assessment',
      'review',
      'reconciliation_coverage',
      'issued_at',
    ]) ||
    !['session_id', 'evidence', 'recorder', 'agent_sources', 'assessment', 'review', 'reconciliation_coverage', 'issued_at'].every(
      (key) => Object.prototype.hasOwnProperty.call(payload, key),
    )
  ) {
    throw new Error('invalid payload fields');
  }
  if (!safeSessionId(payload.session_id) || typeof payload.issued_at !== 'string' || !canonicalIso(payload.issued_at)) {
    throw new Error('invalid session or timestamp');
  }

  const evidence = payload.evidence;
  if (
    !isRecord(evidence) ||
    !exactKeys(evidence, ['first_seq', 'last_seq', 'last_hash', 'event_count']) ||
    !isPositiveInteger(evidence.first_seq) ||
    !isPositiveInteger(evidence.last_seq) ||
    evidence.last_seq < evidence.first_seq ||
    (evidence.event_count as number) > (evidence.last_seq as number) - (evidence.first_seq as number) + 1 ||
    !isHash(evidence.last_hash) ||
    !isPositiveInteger(evidence.event_count)
  ) {
    throw new Error('invalid evidence range');
  }

  if (payload.revision !== undefined) {
    if (!isRecord(payload.revision) || !subsetKeys(payload.revision, ['commit', 'branch']) || Object.keys(payload.revision).length === 0) {
      throw new Error('invalid revision');
    }
    if (payload.revision.commit !== undefined) normalizeCommit(payload.revision.commit as string);
    if (payload.revision.branch !== undefined) normalizeBranch(payload.revision.branch as string);
  }

  const recorder = payload.recorder;
  if (
    !isRecord(recorder) ||
    !exactKeys(recorder, ['id', 'key_fingerprint']) ||
    typeof recorder.id !== 'string' ||
    !/^[0-9a-f]{16}$/.test(recorder.id) ||
    typeof recorder.key_fingerprint !== 'string' ||
    !/^[0-9a-f]{16}$/.test(recorder.key_fingerprint)
  ) {
    throw new Error('invalid recorder identity');
  }
  const agentSources = payload.agent_sources;
  if (
    !Array.isArray(agentSources) ||
    agentSources.some((source) => source !== 'claude-code' && source !== 'gemini-cli') ||
    new Set(agentSources).size !== agentSources.length ||
    [...agentSources].sort().some((source, i) => source !== agentSources[i])
  ) {
    throw new Error('invalid agent source list');
  }

  const assessment = payload.assessment;
  if (
    !isRecord(assessment) ||
    !exactKeys(assessment, ['ruleset', 'rules_hash', 'verdict', 'score', 'findings']) ||
    typeof assessment.ruleset !== 'string' ||
    !isKnownRuleset(assessment.ruleset) ||
    assessment.rules_hash !== rulesFingerprint(assessment.ruleset) ||
    !['none', 'low', 'medium', 'high'].includes(assessment.verdict as string) ||
    !isNonNegativeInteger(assessment.score) ||
    assessment.score > 100
  ) {
    throw new Error('invalid assessment');
  }
  const findings = assessment.findings;
  if (
    !isRecord(findings) ||
    !exactKeys(findings, ['total', 'severity', 'outcome']) ||
    !isNonNegativeInteger(findings.total) ||
    !validSeverityCounts(findings.severity) ||
    !validOutcomeCounts(findings.outcome) ||
    Object.values(findings.severity).reduce((sum, count) => sum + count, 0) !== findings.total ||
    Object.values(findings.outcome).reduce((sum, count) => sum + count, 0) !== findings.total
  ) {
    throw new Error('invalid finding aggregates');
  }

  const review = payload.review;
  const expectedReviewStatus =
    isRecord(review) && review.total === 0
      ? 'clear'
      : isRecord(review) && typeof review.unresolved === 'number' && review.unresolved > 0
        ? 'needs_review'
        : 'reviewed';
  if (
    !isRecord(review) ||
    !exactKeys(review, ['status', 'total', 'unresolved', 'stale', 'dispositions', 'unresolved_by_severity', 'policy_hash']) ||
    !['clear', 'needs_review', 'reviewed'].includes(review.status as string) ||
    !isNonNegativeInteger(review.total) ||
    !isNonNegativeInteger(review.unresolved) ||
    !isNonNegativeInteger(review.stale) ||
    review.unresolved > review.total ||
    review.stale > review.total ||
    !validDispositionCounts(review.dispositions) ||
    !validSeverityCounts(review.unresolved_by_severity) ||
    !(review.policy_hash === null || isHash(review.policy_hash)) ||
    Object.values(review.dispositions).reduce((sum, count) => sum + count, 0) !== review.total ||
    review.dispositions.unreviewed !== review.unresolved ||
    Object.values(review.unresolved_by_severity).reduce((sum, count) => sum + count, 0) !== review.unresolved ||
    review.unresolved_by_severity.high > findings.severity.high ||
    review.unresolved_by_severity.medium > findings.severity.medium ||
    review.unresolved_by_severity.low > findings.severity.low ||
    review.total !== findings.total ||
    review.status !== expectedReviewStatus
  ) {
    throw new Error('invalid review aggregates');
  }
  if (!validReconciliation(payload.reconciliation_coverage)) {
    throw new Error('invalid reconciliation coverage');
  }

  try {
    const publicKey = createPublicKey(value.public_key);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
  } catch {
    throw new Error('invalid Ed25519 public key');
  }
  if (recorder.id !== recorderId(value.public_key) || recorder.key_fingerprint !== keyFingerprint(value.public_key)) {
    throw new Error('recorder fingerprint does not match public key');
  }
  if (!/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(value.signature)) {
    throw new Error('invalid Ed25519 signature encoding');
  }
  return value as unknown as SessionAttestationEnvelopeV1;
}

export type SessionAttestationVerification =
  | { ok: true; envelope: SessionAttestationEnvelopeV1; reason: null }
  | { ok: false; envelope: null; reason: string };

/** Strict standalone schema + Ed25519 verification. No local database required. */
export function verifySessionAttestation(
  input: string | unknown,
  options: { trustedPublicKey?: string | null } = {},
): SessionAttestationVerification {
  try {
    const envelope = parseEnvelope(input);
    const ok = cryptoVerify(
      null,
      sessionAttestationMessage(envelope.payload),
      envelope.public_key,
      Buffer.from(envelope.signature, 'base64'),
    );
    if (!ok) return { ok: false, envelope: null, reason: 'signature-invalid' };
    if (options.trustedPublicKey && !samePublicKey(options.trustedPublicKey, envelope.public_key)) {
      return { ok: false, envelope: null, reason: 'recorder-key-mismatch' };
    }
    return { ok: true, envelope, reason: null };
  } catch (error) {
    return { ok: false, envelope: null, reason: (error as Error).message };
  }
}

export interface CompareSessionAttestationOptions {
  /** Pin verification to a locally trusted recorder key instead of self-signed only. */
  trustedPublicKey: string;
  /** Optional local anti-deletion watermark. When supplied it must validate. */
  watermark?: Watermark | null;
}

export interface SessionAttestationComparison {
  ok: boolean;
  reason: string | null;
  signature_ok: boolean;
  chain_ok: boolean;
  range_matches: boolean;
}

/**
 * Compare a standalone attestation to a local store. Derived review/risk state is
 * deliberately not compared: the signed artifact is a historical snapshot, while
 * local baselines and acknowledgements may legitimately evolve.
 */
export function compareSessionAttestationToStore(
  store: Store,
  input: string | unknown,
  options: CompareSessionAttestationOptions,
): SessionAttestationComparison {
  const standalone = verifySessionAttestation(input);
  if (!standalone.ok) {
    return { ok: false, reason: standalone.reason, signature_ok: false, chain_ok: false, range_matches: false };
  }
  const envelope = standalone.envelope;
  const trusted = options?.trustedPublicKey;
  if (!trusted) {
    return { ok: false, reason: 'trusted-key-required', signature_ok: true, chain_ok: false, range_matches: false };
  }
  if (!samePublicKey(trusted, envelope.public_key)) {
    return { ok: false, reason: 'recorder-key-mismatch', signature_ok: true, chain_ok: false, range_matches: false };
  }
  return store.readSnapshot(() => {
    const integrity = verify(store, {
      trustedPublicKey: trusted,
      watermark: options?.watermark ?? null,
    });
    if (!integrity.ok) {
      return {
        ok: false,
        reason: integrity.break ? `chain-${integrity.break.reason}` : 'chain-invalid',
        signature_ok: true,
        chain_ok: false,
        range_matches: false,
      };
    }
    const events = store.eventsLight(envelope.payload.session_id);
    const first = events[0];
    const last = events[events.length - 1];
    const rangeMatches =
      events.length === envelope.payload.evidence.event_count &&
      first?.seq === envelope.payload.evidence.first_seq &&
      last?.seq === envelope.payload.evidence.last_seq &&
      last?.hash === envelope.payload.evidence.last_hash;
    return {
      ok: rangeMatches,
      reason: rangeMatches ? null : 'session-range-mismatch',
      signature_ok: true,
      chain_ok: true,
      range_matches: rangeMatches,
    };
  });
}
