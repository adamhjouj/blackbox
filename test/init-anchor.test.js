'use strict';
// Custody posture at setup: `blackbox init` must FAIL LOUDLY when no external anchor
// can be resolved, never silently degrade to local-only. decideInitAnchor is the pure
// decision the CLI applies (see cmdInit). Requires dist/ — run `npm run build` first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { decideInitAnchor } = require('../dist/init.js');

const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
const freshCfg = () => join(mkdtempSync(join(tmpdir(), 'bb-init-cfg-')), 'config.json'); // absent file

test('decideInitAnchor FAILS LOUDLY when cwd is not a repo and there is no target/opt-out', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-init-norepo-'));
  try {
    const d = decideInitAnchor({ cwd, cfgPath: freshCfg() });
    assert.equal(d.ok, false);
    assert.match(d.message, /no external anchor target could be resolved/);
    assert.match(d.message, /--local-only-anchor/); // the message points at the escape hatch
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('decideInitAnchor FAILS when cwd is a repo but has no remote (nowhere off-machine)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-init-norem-'));
  try {
    g(cwd, 'init', '-q');
    const d = decideInitAnchor({ cwd, cfgPath: freshCfg() });
    assert.equal(d.ok, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('decideInitAnchor resolves a git anchor from a repo WITH a remote (the default)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-init-rem-'));
  try {
    g(cwd, 'init', '-q');
    g(cwd, 'remote', 'add', 'origin', 'git@example.com:me/x.git');
    const d = decideInitAnchor({ cwd, cfgPath: freshCfg() });
    assert.equal(d.ok, true);
    assert.equal(d.kind, 'git');
    assert.match(d.spec, /^git:/);
    assert.equal(d.remote, 'git@example.com:me/x.git');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('decideInitAnchor honors an explicit --local-only-anchor opt-out', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-init-lo-'));
  try {
    const d = decideInitAnchor({ cwd, localOnly: true, cfgPath: freshCfg() });
    assert.equal(d.ok, true);
    assert.equal(d.kind, 'local-only');
    assert.match(d.path, /anchors\.jsonl$/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('decideInitAnchor keeps an already-configured anchor (never re-resolves)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-init-exist-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'bb-init-cfgx-'));
  const cfg = join(cfgDir, 'config.json');
  try {
    writeFileSync(cfg, JSON.stringify({ anchor: 'file:/var/anchors.jsonl' }));
    const d = decideInitAnchor({ cwd, cfgPath: cfg }); // cwd is not even a repo — existing config wins
    assert.equal(d.ok, true);
    assert.equal(d.kind, 'existing');
    assert.deepEqual(d.target, { kind: 'file', path: '/var/anchors.jsonl' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }
});
