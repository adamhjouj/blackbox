'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  BaselinePolicyError,
  baselinePolicyHash,
  loadBaselinePolicy,
  matchBaseline,
  parseBaselinePolicy,
} = require('../dist/baseline.js');

function policy(expected) {
  return { version: 1, expected };
}

test('policy hash is deterministic across entry, selector, and object ordering', () => {
  const left = policy([
    { id: 'z-rule', reason: 'known tool', rule_ids: ['mass-*', 'dangerous-shell'] },
    { id: 'a-path', reason: 'fixture', paths: ['test/**', 'examples/**'] },
  ]);
  const right = {
    expected: [
      { paths: ['examples/**', 'test/**'], reason: 'fixture', id: 'a-path' },
      { rule_ids: ['dangerous-shell', 'mass-*'], id: 'z-rule', reason: 'known tool' },
    ],
    version: 1,
  };
  assert.equal(baselinePolicyHash(left), baselinePolicyHash(right));
  assert.deepEqual(parseBaselinePolicy(right), parseBaselinePolicy(left));
});

test('baseline selectors support exact/glob matching and AND categories', () => {
  const parsed = parseBaselinePolicy(policy([
    { id: 'finding-and-rule', reason: 'reviewed workflow', finding_ids: ['action-*'], rule_ids: ['dangerous-shell'] },
    { id: 'corp-egress', reason: 'approved internal endpoint', hosts: ['*.corp.example'] },
    { id: 'test-fixture', reason: 'synthetic fixture', paths: ['test/**'] },
    { id: 'test-command', reason: 'test runner', command_prefixes: ['npm test'] },
    { id: 'approved-mcp', reason: 'approved connector', mcp_servers: ['github-*'] },
    { id: 'must-not-match', reason: 'both fields are required', rule_ids: ['auth-edit'], paths: ['test/**'] },
  ]));
  const matches = matchBaseline(parsed, {
    finding_id: 'action-risk',
    rule_ids: ['dangerous-shell'],
    hosts: ['api.corp.example'],
    paths: ['/work/repo/test/fixtures/key.env'],
    commands: ['npm test -- --watch'],
    mcp_servers: ['github-main'],
  });
  assert.deepEqual(matches.map((match) => match.id), [
    'approved-mcp',
    'corp-egress',
    'finding-and-rule',
    'test-command',
    'test-fixture',
  ]);

  assert.equal(matchBaseline(parseBaselinePolicy(policy([
    { id: 'boundary', reason: 'must be a command prefix', command_prefixes: ['npm test'] },
  ])), {
    finding_id: 'action-risk', rule_ids: [], hosts: [], paths: [], commands: ['npm tester'], mcp_servers: [],
  }).length, 0);
});

test('malformed or ambiguous policies fail closed', () => {
  assert.throws(() => parseBaselinePolicy({ version: 2, expected: [] }), BaselinePolicyError);
  assert.throws(() => parseBaselinePolicy({ version: 1, expected: [], expectd: [] }), /unknown field/);
  assert.throws(() => parseBaselinePolicy(policy([{ id: 'empty', reason: 'no selector' }])), /at least one selector/);
  assert.throws(() => parseBaselinePolicy(policy([
    { id: 'same', reason: 'one', hosts: ['one.example'] },
    { id: 'same', reason: 'two', hosts: ['two.example'] },
  ])), /duplicate baseline id/);
});

test('loader is bounded, returns null when absent, and rejects policy symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'blackbox-policy-'));
  const linkedRoot = mkdtempSync(join(tmpdir(), 'blackbox-policy-link-'));
  try {
    assert.equal(loadBaselinePolicy(root), null);
    const dir = join(root, '.blackbox');
    mkdirSync(dir);
    const path = join(dir, 'policy.json');
    writeFileSync(path, JSON.stringify(policy([{ id: 'ok', reason: 'test', hosts: ['*.example'] }])));
    const loaded = loadBaselinePolicy(root);
    assert.equal(loaded.policy.expected[0].id, 'ok');
    assert.equal(loaded.hash, baselinePolicyHash(loaded.policy));
    assert.throws(() => loadBaselinePolicy(root, { maxBytes: 8 }), /exceeds the 8-byte policy limit/);

    rmSync(path);
    const target = join(root, 'elsewhere.json');
    writeFileSync(target, JSON.stringify(policy([])));
    symlinkSync(target, path);
    assert.throws(() => loadBaselinePolicy(root), /symlink/);

    const externalDir = join(linkedRoot, 'external-policy');
    mkdirSync(externalDir);
    writeFileSync(join(externalDir, 'policy.json'), JSON.stringify(policy([])));
    symlinkSync(externalDir, join(linkedRoot, '.blackbox'));
    assert.throws(() => loadBaselinePolicy(linkedRoot), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(linkedRoot, { recursive: true, force: true });
  }
});
