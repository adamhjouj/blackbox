'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Store } = require('../dist/store.js');
const { verifySessionAttestation } = require('../dist/attest.js');
const { attestationFailsAt } = require('../dist/github-check.js');
const { normEv } = require('./util.js');

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const SESSION = 'CLI-ATTEST![x](https://attacker.example)';
const COMMIT = 'a'.repeat(40);

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function seed(db) {
  const store = new Store(db);
  try {
    store.append({
      ...normEv({
        session_id: SESSION,
        phase: 'session_start',
        hook_event: 'SessionStart',
        action_type: 'session',
        raw: JSON.stringify({ prompt: 'RAW_PROMPT_SECRET' }),
        detail: JSON.stringify({ anchor: { head_sha: COMMIT, branch: 'feature/attest' } }),
      }),
      source: 'claude-code',
    });
    store.append({
      ...normEv({
        session_id: SESSION,
        phase: 'post',
        hook_event: 'PostToolUse',
        action_type: 'file_write',
        tool_name: 'Write',
        target: '/repo/.blackbox/signing.key',
        raw: JSON.stringify({ command: 'RAW_COMMAND_SECRET' }),
      }),
      source: 'gemini-cli',
    });
  } finally {
    store.close();
  }
}

test('attest CLI creates private artifacts, verifies locally, gates Actions, and refuses unsafe input', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-attest-cli-'));
  const home = join(root, 'home');
  const db = join(root, 'evidence.db');
  const artifact = join(root, 'session.attestation.json');
  const tampered = join(root, 'tampered.json');
  const summary = join(root, 'summary.md');
  const outputs = join(root, 'outputs.txt');
  mkdirSync(home, { recursive: true });
  seed(db);
  const env = { BLACKBOX_HOME: home, BLACKBOX_DB: db, GITHUB_SHA: COMMIT };

  try {
    const created = run(['attest', '--session', SESSION, '--out', artifact], env);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /wrote signed attestation/);
    if (process.platform !== 'win32') assert.equal(statSync(artifact).mode & 0o777, 0o600);
    const envelope = JSON.parse(readFileSync(artifact, 'utf8'));
    assert.equal(verifySessionAttestation(envelope).ok, true);
    assert.deepEqual(envelope.payload.agent_sources, ['claude-code', 'gemini-cli']);
    assert.equal(envelope.payload.revision.commit, COMMIT);
    assert.equal(envelope.payload.review.unresolved_by_severity.high > 0, true);
    for (const threshold of ['high', 'medium', 'low']) assert.equal(attestationFailsAt(envelope, threshold), true);
    assert.doesNotMatch(readFileSync(artifact, 'utf8'), /RAW_(?:PROMPT|COMMAND)_SECRET/);

    const refused = run(['attest', '--session', SESSION, '--out', artifact], env);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /refusing to replace/);

    const checked = run(['attest', 'verify', artifact, '--check'], env);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /trusted local recorder key/);
    const pinned = run(['attest', 'verify', artifact, '--trusted-key', join(home, 'signing.pub')], env);
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.match(pinned.stdout, /pinned recorder public key/);

    const untrustedGate = run(['attest', 'verify', artifact, '--fail-on', 'low'], env);
    assert.equal(untrustedGate.status, 2);
    assert.match(untrustedGate.stderr, /requires --trusted-key/);
    for (const argv of [
      ['attest', 'verify', artifact, '--fail-on'],
      ['attest', 'verify', artifact, '--trusted-key'],
      ['attest', '--session'],
      ['attest', '--out'],
      ['attest', 'verify', artifact, '--not-a-real-option'],
      ['attest', 'verify', artifact, 'extra'],
    ]) {
      assert.equal(run(argv, env).status, 2, `expected usage failure for ${argv.join(' ')}`);
    }
    const noArtifact = run(
      ['attest', '--session', SESSION, '--github-output'],
      { ...env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
    );
    assert.equal(noArtifact.status, 2);
    assert.match(noArtifact.stderr, /requires --out/);

    writeFileSync(summary, '');
    writeFileSync(outputs, '');
    const wrongRevision = run(
      ['attest', 'verify', artifact, '--trusted-key', join(home, 'signing.pub'), '--github-output', '--expected-commit', 'b'.repeat(40)],
      { ...env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs },
    );
    assert.equal(wrongRevision.status, 2);
    assert.match(wrongRevision.stderr, /expected GitHub revision/);
    assert.equal(readFileSync(summary, 'utf8'), '');
    assert.equal(readFileSync(outputs, 'utf8'), '');

    const informational = run(
      ['attest', 'verify', artifact, '--trusted-key', join(home, 'signing.pub'), '--github-output'],
      { ...env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs },
    );
    assert.equal(informational.status, 0, informational.stderr);
    assert.match(readFileSync(outputs, 'utf8'), /^blackbox_result=informational$/m);

    writeFileSync(summary, '');
    writeFileSync(outputs, '');
    const gated = run(
      ['attest', 'verify', artifact, '--trusted-key', join(home, 'signing.pub'), '--github-output', '--fail-on', 'low'],
      { ...env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs },
    );
    assert.equal(gated.status, 1, gated.stderr);
    assert.match(readFileSync(summary, 'utf8'), /Blackbox pre-merge review/);
    assert.doesNotMatch(readFileSync(summary, 'utf8'), /!\[x\]\(/);
    assert.match(readFileSync(outputs, 'utf8'), /^blackbox_result=fail$/m);
    assert.match(readFileSync(outputs, 'utf8'), /^blackbox_attestation_file=session\.attestation\.json$/m);
    assert.doesNotMatch(readFileSync(summary, 'utf8') + readFileSync(outputs, 'utf8'), /RAW_(?:PROMPT|COMMAND)_SECRET/);

    const forged = JSON.parse(readFileSync(artifact, 'utf8'));
    forged.payload.assessment.score = forged.payload.assessment.score === 100 ? 99 : forged.payload.assessment.score + 1;
    writeFileSync(tampered, JSON.stringify(forged));
    const invalid = run(['attest', 'verify', tampered], env);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /invalid session attestation/);

    const oversized = join(root, 'oversized.json');
    writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const tooLarge = run(['attest', 'verify', oversized], env);
    assert.equal(tooLarge.status, 2);
    assert.match(tooLarge.stderr, /larger than/);

    if (process.platform !== 'win32') {
      const linked = join(root, 'linked-attestation.json');
      symlinkSync(artifact, linked);
      const symlinked = run(['attest', 'verify', linked], env);
      assert.equal(symlinked.status, 2);
      assert.match(symlinked.stderr, /cannot safely read/);

      const victim = join(root, 'victim.md');
      const maliciousSummary = join(root, 'summary-link.md');
      writeFileSync(victim, 'do not modify\n');
      symlinkSync(victim, maliciousSummary);
      const unsafeRunner = run(
        ['attest', 'verify', artifact, '--trusted-key', join(home, 'signing.pub'), '--github-output'],
        { ...env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: maliciousSummary },
      );
      assert.equal(unsafeRunner.status, 2);
      assert.equal(readFileSync(victim, 'utf8'), 'do not modify\n');
      assert.equal(lstatSync(maliciousSummary).isSymbolicLink(), true);
    }
  } finally {
    try { chmodSync(root, 0o700); } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});
