'use strict';
// A git commit subject/author can carry a secret, and it flows into the shareable
// report + forensic case-file — so it must be redacted before persistence. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { normalizeGit, parseRefLines } = require('../dist/git-collector.js');
const { captureWorktreeDelta } = require('../dist/worktree.js');
const { GIT_SAFE_FLAGS } = require('../dist/git-safe.js');

test('normalizeGit redacts a secret in the commit subject/author before persistence', () => {
  const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const ev = normalizeGit({
    repoTop: '/repo',
    delta: { ref: 'refs/heads/main', old: '0'.repeat(40), new: 'a'.repeat(40) },
    cls: { kind: 'commit', is_force: false, is_reset: false, is_delete: false, is_amend: false },
    diff: { files: 1, insertions: 1, deletions: 0 },
    commit: { sha: 'a'.repeat(40), author: 'Dev <' + key + '@x.io>', subject: 'stash key ' + key, ts: '2026-02-01T00:00:00Z' },
    correlation: { confidence: 'none', session_id: 'S', tool_use_id: null, candidates: [] },
    rawBody: 'x',
    capturedAt: '2026-02-01T00:00:00.000Z',
  });
  assert.ok(!ev.detail.includes(key), 'secret leaked into the stored git detail');
  const d = JSON.parse(ev.detail);
  assert.ok(d.git.commit.subject.includes('[REDACTED'), 'commit subject should be redacted');
  assert.ok(d.git.commit.author.includes('[REDACTED'), 'commit author should be redacted');
  assert.equal(d.git.commit.sha, 'a'.repeat(40), 'sha is not a secret — kept verbatim');
});

// W0.1b — a malicious repo can set core.fsmonitor to an arbitrary program that git
// EXECUTES the next time it refreshes the index. The daemon reads hook-supplied,
// agent-controlled repo paths, so `git diff`/`ls-files` in captureWorktreeDelta must
// not run that program. GIT_SAFE_FLAGS (`-c core.fsmonitor=false`) neutralises it.
test('W0.1b: GIT_SAFE_FLAGS pins core.fsmonitor=false and core.hooksPath', () => {
  assert.deepEqual([...GIT_SAFE_FLAGS], ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']);
});

test('R6: parseRefLines skips blackbox own anchor ref (no self-generated noise)', () => {
  const z = '0'.repeat(40);
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const body = [`${z} ${a} refs/blackbox/anchors`, `${a} ${b} refs/heads/main`].join('\n');
  const deltas = parseRefLines(body);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].ref, 'refs/heads/main');
});

test('W0.1b: captureWorktreeDelta does NOT execute a hostile core.fsmonitor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-fsmon-'));
  const canary = join(dir, 'PWNED');
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // arm the exploit + make the worktree dirty so a diff/refresh is forced
    git('config', 'core.fsmonitor', 'touch ' + canary);
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');

    const delta = captureWorktreeDelta(dir, base);
    assert.ok(!existsSync(canary), 'hostile core.fsmonitor EXECUTED — the daemon is exploitable');
    // the capture itself still works (the change is seen)
    assert.ok(delta && delta.files.some((f) => f.path === 'a.txt'), 'worktree delta should still capture the edit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
