'use strict';
// watch.ts installs the git reference-transaction + pre-push hooks that feed the
// git-forensics collector — the entry point for git ground truth. It had no tests.
// Uses a throwaway BLACKBOX_HOME (so the token/config write there, not the real
// ~/.blackbox) + temp repos. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

process.env.BLACKBOX_HOME = mkdtempSync('/tmp/bbwatch-home-'); // before requiring the module
const { watchRepo, unwatchRepo } = require('../dist/watch.js');

function initRepo() {
  const repo = mkdtempSync('/tmp/bbwatch-');
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
  return repo;
}
const hookPath = (repo, name) => join(repo, '.git', 'hooks', name);
const isExec = (f) => (statSync(f).mode & 0o111) !== 0;

test('watchRepo installs both git-forensics hooks (executable, marked, posting to /git)', () => {
  const repo = initRepo();
  try {
    watchRepo(repo);
    for (const name of ['reference-transaction', 'pre-push']) {
      const f = hookPath(repo, name);
      assert.ok(existsSync(f), `${name} installed`);
      const body = readFileSync(f, 'utf8');
      assert.ok(body.includes('>>> blackbox'), 'blackbox marker present');
      assert.ok(body.includes('/git'), 'posts the ref-delta to the daemon /git');
      assert.ok(body.includes('X-BB-Token:'), 'carries the per-install token');
      assert.ok(isExec(f), 'hook is executable');
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('watchRepo is idempotent (a second install is a no-op)', () => {
  const repo = initRepo();
  try {
    watchRepo(repo);
    const r2 = watchRepo(repo);
    for (const name of ['reference-transaction', 'pre-push']) assert.equal(r2.actions[name], 'already');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('unwatchRepo removes blackbox hooks from a repo', () => {
  const repo = initRepo();
  try {
    watchRepo(repo);
    unwatchRepo(repo);
    assert.ok(!existsSync(hookPath(repo, 'reference-transaction')), 'fresh hook removed');
    assert.ok(!existsSync(hookPath(repo, 'pre-push')), 'fresh hook removed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("watchRepo wraps a pre-existing hook and unwatch restores the user's original", () => {
  const repo = initRepo();
  try {
    const f = hookPath(repo, 'pre-push');
    writeFileSync(f, '#!/bin/sh\necho "user original"\nexit 0\n', { mode: 0o755 });

    const r = watchRepo(repo);
    assert.equal(r.actions['pre-push'], 'wrapped');
    const wrapped = readFileSync(f, 'utf8');
    assert.ok(wrapped.includes('>>> blackbox'), 'blackbox wrapper installed');
    assert.ok(existsSync(f + '.blackbox-orig'), "the user's original is preserved");

    unwatchRepo(repo);
    const restored = readFileSync(f, 'utf8');
    assert.ok(restored.includes('user original'), "the user's original hook is restored");
    assert.ok(!restored.includes('>>> blackbox'), 'the blackbox wrapper is gone');
    assert.ok(!existsSync(f + '.blackbox-orig'), 'the .orig backup is consumed on restore');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test.after(() => rmSync(process.env.BLACKBOX_HOME, { recursive: true, force: true }));
