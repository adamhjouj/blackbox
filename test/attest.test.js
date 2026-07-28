'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const {
  SESSION_ATTESTATION_DOMAIN,
  compareSessionAttestationToStore,
  createSessionAttestation,
  sessionAttestationMessage,
  verifySessionAttestation,
} = require('../dist/attest.js');
const { deriveReviewFindings } = require('../dist/review.js');
const { computeSession } = require('../dist/risk-engine.js');
const { RULESET_VERSION, rulesFingerprint } = require('../dist/risk-rules.js');
const { normEv, tempStore } = require('./util.js');

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function resign(envelope, keys) {
  envelope.signature = crypto.sign(null, sessionAttestationMessage(envelope.payload), keys.privateKeyPem).toString('base64');
  return envelope;
}

function seed(store) {
  store.append({
    ...normEv({
      session_id: 'ATTEST-1',
      phase: 'session_start',
      hook_event: 'SessionStart',
      action_type: 'session',
      cwd: '/private/PATH_SECRET_MARKER',
      raw: JSON.stringify({ prompt: 'PROMPT_SECRET_MARKER', remote: 'REMOTE_SECRET_MARKER' }),
      detail: JSON.stringify({
        anchor: {
          head_sha: 'a'.repeat(40),
          branch: 'feature/signed-attestations',
          remote: 'REMOTE_SECRET_MARKER',
        },
      }),
    }),
    source: 'codex-cli',
  });
  store.append({
    ...normEv({
      session_id: 'ATTEST-1',
      tool_use_id: 'danger',
      phase: 'post',
      hook_event: 'PostToolUse',
      action_type: 'file_write',
      tool_name: 'Write',
      target: '/private/PATH_SECRET_MARKER/auth/config.yml',
      raw: JSON.stringify({ command: 'COMMAND_SECRET_MARKER' }),
    }),
    source: 'gemini-cli',
  });
  store.append({
    ...normEv({
      session_id: 'ATTEST-1',
      tool_use_id: 'tamper',
      phase: 'post',
      hook_event: 'PostToolUse',
      action_type: 'file_write',
      tool_name: 'Write',
      target: '/private/PATH_SECRET_MARKER/.blackbox/signing.key',
      raw: JSON.stringify({ content: 'BLOB_SECRET_MARKER' }),
    }),
    source: 'claude-code',
  });
  store.append({
    ...normEv({
      session_id: 'ATTEST-1',
      phase: 'session_end',
      hook_event: 'SessionEnd',
      action_type: 'session',
      detail: JSON.stringify({
        anchor: { head_sha: 'b'.repeat(40), branch: 'feature/final-revision' },
      }),
    }),
    source: 'claude-code',
  });
  return store.eventsLight('ATTEST-1');
}

function addCurrentReviewAndCoverage(store, events) {
  const current = computeSession(store, 'ATTEST-1', RULESET_VERSION);
  const findings = deriveReviewFindings({
    session_id: 'ATTEST-1',
    ruleset_version: RULESET_VERSION,
    events,
    combos: current.verdict.combos,
    risks: current.risks,
    baseline: null,
  });
  const medium = findings.find((finding) => finding.severity === 'medium');
  assert.ok(medium, 'fixture should create a medium finding');
  const last = events.at(-1);
  store.reviewAppend({
    id: crypto.randomUUID(),
    session_id: 'ATTEST-1',
    finding_key: medium.key,
    disposition: 'acknowledged',
    note: 'NOTE_SECRET_MARKER',
    reviewed_through_seq: last.seq,
    reviewed_through_hash: last.hash,
    policy_hash: null,
    created_at: '2026-07-28T12:00:00.000Z',
  });
  store.reconciliationUpsert({
    session_id: 'ATTEST-1',
    ruleset_version: 'v1',
    corroborated: 1,
    finding_count: 1,
    findings: JSON.stringify([{ path: 'PATH_SECRET_MARKER', note: 'NOTE_SECRET_MARKER' }]),
    coverage: JSON.stringify({
      corroborated: true,
      reason: 'REMOTE_SECRET_MARKER',
      files_on_disk: 3,
      hook_files: 2,
      truncated: false,
      completeness: {
        transcript_tool_uses: 4,
        recorded: 3,
        missing: [{ id: 'PROMPT_SECRET_MARKER', name: 'COMMAND_SECRET_MARKER', explained: 'unexplained' }],
        coverage_ratio: 0.75,
      },
    }),
    last_seq: last.seq,
    computed_at: '2026-07-28T12:00:00.000Z',
  });
  // Deliberately persist a stale/false verdict. Attestation must replay the
  // immutable events instead of trusting this row.
  store.sessionRiskUpsert({
    session_id: 'ATTEST-1',
    ruleset_version: RULESET_VERSION,
    verdict: 'none',
    score: 0,
    combos: null,
    rule_counts: '{}',
    last_scored_seq: 1,
    rules_hash: 'sha256:' + '0'.repeat(64),
    computed_at: '2026-07-28T12:00:00.000Z',
  });
  return findings;
}

function walk(value, keys = [], strings = []) {
  if (typeof value === 'string') strings.push(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keys, strings);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      walk(child, keys, strings);
    }
  }
  return { keys, strings };
}

test('attestation signs a current aggregate projection and verifies standalone/locally', () => {
  const store = tempStore();
  try {
    const events = seed(store);
    const projected = addCurrentReviewAndCoverage(store, events);
    const keys = keypair();
    const options = { issuedAt: '2026-07-28T12:34:56.000Z' };
    const envelope = createSessionAttestation(store, 'ATTEST-1', keys, options);
    const repeated = createSessionAttestation(store, 'ATTEST-1', keys, options);

    assert.deepEqual(repeated, envelope, 'canonical projection + injected time must sign deterministically');
    assert.equal(envelope.format, 'blackbox-session-attestation');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.payload.assessment.ruleset, RULESET_VERSION);
    assert.notEqual(envelope.payload.assessment.verdict, 'none', 'stale persisted verdict must not be attested');
    assert.equal(envelope.payload.assessment.findings.total, projected.length);
    assert.equal(envelope.payload.review.dispositions.acknowledged, 1);
    assert.equal(envelope.payload.review.unresolved, projected.length - 1);
    assert.equal(
      Object.values(envelope.payload.review.unresolved_by_severity).reduce((sum, n) => sum + n, 0),
      envelope.payload.review.unresolved,
    );
    assert.deepEqual(envelope.payload.agent_sources, ['claude-code', 'codex-cli', 'gemini-cli']);
    assert.deepEqual(envelope.payload.revision, {
      commit: 'b'.repeat(40),
      branch: 'feature/final-revision',
    });
    assert.deepEqual(envelope.payload.reconciliation_coverage, {
      corroborated: true,
      files_on_disk: 3,
      hook_files: 2,
      truncated: false,
      completeness: {
        transcript_tool_uses: 4,
        recorded: 3,
        missing: 1,
        unexplained_missing: 1,
        coverage_ratio: 0.75,
      },
    });
    assert.ok(SESSION_ATTESTATION_DOMAIN.startsWith('blackbox-session-attestation-v1'));

    const standalone = verifySessionAttestation(JSON.stringify(envelope));
    assert.equal(standalone.ok, true);
    assert.deepEqual(
      compareSessionAttestationToStore(store, envelope, { trustedPublicKey: keys.publicKeyPem }),
      { ok: true, reason: null, signature_ok: true, chain_ok: true, range_matches: true },
    );
    assert.deepEqual(compareSessionAttestationToStore(store, envelope), {
      ok: false,
      reason: 'trusted-key-required',
      signature_ok: true,
      chain_ok: false,
      range_matches: false,
    });
  } finally {
    store.cleanup();
  }
});

test('attestation rejects tampering and unknown fields', () => {
  const store = tempStore();
  try {
    seed(store);
    const envelope = createSessionAttestation(store, 'ATTEST-1', keypair(), {
      issuedAt: '2026-07-28T12:34:56.000Z',
    });
    const forged = structuredClone(envelope);
    forged.payload.assessment.score = Math.max(0, forged.payload.assessment.score - 1);
    assert.deepEqual(verifySessionAttestation(forged), {
      ok: false,
      envelope: null,
      reason: 'signature-invalid',
    });

    const smuggled = structuredClone(envelope);
    smuggled.payload.raw = 'should never be accepted';
    assert.equal(verifySessionAttestation(smuggled).ok, false);
    assert.match(verifySessionAttestation(smuggled).reason, /payload fields/);

    assert.deepEqual(verifySessionAttestation(envelope, { trustedPublicKey: keypair().publicKeyPem }), {
      ok: false,
      envelope: null,
      reason: 'recorder-key-mismatch',
    });
  } finally {
    store.cleanup();
  }
});

test('attestation recursively excludes raw evidence and privacy-sensitive fields/values', () => {
  const store = tempStore();
  try {
    const events = seed(store);
    addCurrentReviewAndCoverage(store, events);
    const envelope = createSessionAttestation(store, 'ATTEST-1', keypair(), {
      issuedAt: '2026-07-28T12:34:56.000Z',
    });
    const { keys, strings } = walk(envelope);
    const forbiddenKeys = new Set([
      'name', 'title', 'cwd', 'remote', 'prompt', 'prompts', 'command', 'commands',
      'path', 'paths', 'host', 'hosts', 'target', 'note', 'notes', 'raw', 'blob', 'blobs',
    ]);
    assert.deepEqual([...new Set(keys.filter((key) => forbiddenKeys.has(key)))], []);
    const serializedStrings = strings.join('\n');
    for (const marker of [
      'PATH_SECRET_MARKER',
      'PROMPT_SECRET_MARKER',
      'REMOTE_SECRET_MARKER',
      'COMMAND_SECRET_MARKER',
      'NOTE_SECRET_MARKER',
      'BLOB_SECRET_MARKER',
    ]) {
      assert.doesNotMatch(serializedStrings, new RegExp(marker));
    }
  } finally {
    store.cleanup();
  }
});

test('attestation refuses a broken evidence chain and validates a supplied watermark', () => {
  const store = tempStore();
  try {
    seed(store);
    const keys = keypair();
    const raw = new Database(store.dbPath);
    raw.prepare("UPDATE events SET target = 'tampered-after-recording' WHERE seq = 2").run();
    raw.close();
    assert.throws(
      () => createSessionAttestation(store, 'ATTEST-1', keys, { issuedAt: '2026-07-28T12:34:56.000Z' }),
      (error) => error?.code === 'chain-invalid' && /content-tampered/.test(error.message),
    );
  } finally {
    store.cleanup();
  }

  const clean = tempStore();
  try {
    seed(clean);
    assert.throws(
      () =>
        createSessionAttestation(clean, 'ATTEST-1', keypair(), {
          watermark: { seq: 3, head_hash: 'sha256:' + 'f'.repeat(64) },
          issuedAt: '2026-07-28T12:34:56.000Z',
        }),
      (error) => error?.code === 'chain-invalid',
    );
  } finally {
    clean.cleanup();
  }
});

test('strict verification preserves historical rulesets and rejects impossible signed aggregates', () => {
  const store = tempStore();
  try {
    const events = seed(store);
    addCurrentReviewAndCoverage(store, events);
    const keys = keypair();
    const envelope = createSessionAttestation(store, 'ATTEST-1', keys, {
      issuedAt: '2026-07-28T12:34:56.000Z',
    });

    const historical = structuredClone(envelope);
    historical.payload.assessment.ruleset = 'r3';
    historical.payload.assessment.rules_hash = rulesFingerprint('r3');
    assert.equal(verifySessionAttestation(resign(historical, keys)).ok, true);

    const impossibleRange = structuredClone(envelope);
    impossibleRange.payload.evidence.event_count =
      impossibleRange.payload.evidence.last_seq - impossibleRange.payload.evidence.first_seq + 2;
    assert.match(verifySessionAttestation(resign(impossibleRange, keys)).reason, /evidence range/);

    const impossibleSeverity = structuredClone(envelope);
    const highFindings = impossibleSeverity.payload.assessment.findings.severity.high;
    assert.equal(highFindings > 0, true);
    impossibleSeverity.payload.assessment.findings.severity.high = 0;
    impossibleSeverity.payload.assessment.findings.severity.low += highFindings;
    assert.match(verifySessionAttestation(resign(impossibleSeverity, keys)).reason, /review aggregates/);

    const impossibleCoverage = structuredClone(envelope);
    assert.ok(impossibleCoverage.payload.reconciliation_coverage.completeness);
    impossibleCoverage.payload.reconciliation_coverage.completeness.missing += 1;
    assert.match(verifySessionAttestation(resign(impossibleCoverage, keys)).reason, /reconciliation coverage/);
  } finally {
    store.cleanup();
  }
});
