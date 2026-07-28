import { closeSync, constants, fstatSync, lstatSync, openSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { verifySessionAttestation, type SessionAttestationEnvelopeV1 } from './attest';

export type FindingThreshold = 'high' | 'medium' | 'low';

export interface GitHubCheckResult {
  conclusion: 'informational' | 'pass' | 'fail';
  failed: boolean;
  summary_written: boolean;
  outputs_written: boolean;
}

/** Decide a pre-merge gate from the signed current unresolved aggregates. */
export function attestationFailsAt(envelope: SessionAttestationEnvelopeV1, threshold: FindingThreshold): boolean {
  const verified = verifySessionAttestation(envelope);
  if (!verified.ok) throw new Error(`cannot evaluate an invalid attestation: ${verified.reason}`);
  const counts = verified.envelope.payload.review.unresolved_by_severity;
  if (threshold === 'high') return counts.high > 0;
  if (threshold === 'medium') return counts.high + counts.medium > 0;
  return counts.high + counts.medium + counts.low > 0;
}

function markdownCell(value: unknown): string {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n\u0000]/g, ' ')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, (character) => `&#${character.codePointAt(0)};`);
}

function outputValue(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\u0000]/g, ' ').slice(0, 2_048);
}

function appendRunnerFile(path: string, contents: string): void {
  let fd: number | null = null;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const before = noFollow === 0 ? lstatSync(path) : null;
    if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error(`${path} is not a regular runner file`);
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | noFollow);
    const after = fstatSync(fd);
    if (!after.isFile() || (before && (before.dev !== after.dev || before.ino !== after.ino))) {
      throw new Error(`${path} is not a stable regular runner file`);
    }
    writeFileSync(fd, contents, 'utf8');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function renderGitHubCheckSummary(
  envelope: SessionAttestationEnvelopeV1,
  options: {
    threshold?: FindingThreshold | null;
    attestationPath?: string | null;
    trust?: 'self-signed' | 'pinned-key' | 'local-recorder';
    expectedCommit?: string | null;
  } = {},
): string {
  const verified = verifySessionAttestation(envelope);
  if (!verified.ok) throw new Error(`cannot render an invalid attestation: ${verified.reason}`);
  const payload = verified.envelope.payload;
  const threshold = options.threshold ?? null;
  const failed = threshold ? attestationFailsAt(envelope, threshold) : false;
  const coverage = payload.reconciliation_coverage?.completeness;
  const source = payload.agent_sources.length ? payload.agent_sources.join(', ') : 'legacy / unspecified';
  const result = threshold ? (failed ? 'Review required' : 'Pass') : 'Informational';
  const trust = options.trust === 'pinned-key'
    ? 'signature valid · recorder key pinned by workflow'
    : options.trust === 'local-recorder'
      ? 'signature valid · matched this machine’s recorder key and evidence'
      : 'signature valid · recorder identity not pinned';
  const lines = [
    '## Blackbox pre-merge review',
    '',
    `**${result}**${threshold ? ` · fails on unresolved ${threshold}+ findings` : ''}`,
    '',
    '| Field | Signed value |',
    '| --- | --- |',
    `| Session | ${markdownCell(payload.session_id)} |`,
    `| Revision | ${markdownCell(payload.revision?.commit ?? 'not captured')} |`,
    `| Recorder | ${markdownCell(payload.recorder.id)} |`,
    `| Verification | ${markdownCell(trust)} |`,
    `| Agent source | ${markdownCell(source)} |`,
    `| Verdict / score | ${markdownCell(payload.assessment.verdict)} / ${markdownCell(payload.assessment.score)} |`,
    `| Current unresolved | ${markdownCell(payload.review.unresolved)} (${payload.review.unresolved_by_severity.high} high · ${payload.review.unresolved_by_severity.medium} medium · ${payload.review.unresolved_by_severity.low} low) |`,
    `| Evidence range | ${payload.evidence.first_seq}–${payload.evidence.last_seq} · ${payload.evidence.event_count} events |`,
    `| Capture coverage | ${coverage ? `${Math.round(coverage.coverage_ratio * 100)}% · ${coverage.unexplained_missing} unexplained missing` : 'not available'} |`,
    `| Attestation | ${markdownCell(options.attestationPath ? basename(options.attestationPath) : 'emitted to stdout')} |`,
    '',
    'This summary contains signed aggregate metadata only. Raw evidence remains in the local Blackbox store.',
    '',
  ];
  return lines.join('\n');
}

/** Append an Actions summary and typed step outputs. GitHub turns the job into a
 * repository Check; no GitHub token or direct Checks API call is required. */
export function emitGitHubCheckOutput(
  envelope: SessionAttestationEnvelopeV1,
  options: {
    threshold?: FindingThreshold | null;
    attestationPath?: string | null;
    trust?: 'self-signed' | 'pinned-key' | 'local-recorder';
    expectedCommit?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): GitHubCheckResult {
  const env = options.env ?? process.env;
  if (env.GITHUB_ACTIONS !== 'true') {
    throw new Error('--github-output requires a GitHub Actions runner (GITHUB_ACTIONS=true)');
  }
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  const outputPath = env.GITHUB_OUTPUT;
  if (!summaryPath && !outputPath) {
    throw new Error('GitHub Actions did not provide GITHUB_STEP_SUMMARY or GITHUB_OUTPUT');
  }
  if (options.trust !== 'pinned-key' && options.trust !== 'local-recorder') {
    throw new Error('GitHub output requires a pinned or locally verified recorder identity');
  }
  const verified = verifySessionAttestation(envelope);
  if (!verified.ok) throw new Error(`cannot emit an invalid attestation: ${verified.reason}`);
  envelope = verified.envelope;
  const expectedCommit = (options.expectedCommit ?? env.GITHUB_SHA ?? '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedCommit)) {
    throw new Error('GitHub output requires a full --expected-commit SHA (or GITHUB_SHA)');
  }
  if (envelope.payload.revision?.commit !== expectedCommit) {
    throw new Error(
      `attested revision ${envelope.payload.revision?.commit ?? 'is missing'}; expected GitHub revision ${expectedCommit}`,
    );
  }
  const threshold = options.threshold ?? null;
  const failed = threshold ? attestationFailsAt(envelope, threshold) : false;
  const conclusion: GitHubCheckResult['conclusion'] = threshold ? (failed ? 'fail' : 'pass') : 'informational';
  if (summaryPath) {
    appendRunnerFile(summaryPath, renderGitHubCheckSummary(envelope, options));
  }
  if (outputPath) {
    const payload = envelope.payload;
    const values: Record<string, string | number> = {
      blackbox_result: conclusion,
      blackbox_session_id: payload.session_id,
      blackbox_verdict: payload.assessment.verdict,
      blackbox_score: payload.assessment.score,
      blackbox_unresolved: payload.review.unresolved,
      blackbox_unresolved_high: payload.review.unresolved_by_severity.high,
      blackbox_unresolved_medium: payload.review.unresolved_by_severity.medium,
      blackbox_unresolved_low: payload.review.unresolved_by_severity.low,
      blackbox_recorder_id: payload.recorder.id,
      blackbox_attestation_file: options.attestationPath ? basename(options.attestationPath) : '',
    };
    appendRunnerFile(
      outputPath,
      Object.entries(values).map(([key, value]) => `${key}=${outputValue(value)}`).join('\n') + '\n',
    );
  }
  return {
    conclusion,
    failed,
    summary_written: !!summaryPath,
    outputs_written: !!outputPath,
  };
}
