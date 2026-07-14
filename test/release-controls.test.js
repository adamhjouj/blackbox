'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { formatBytes, staticDoctorChecks } = require('../dist/doctor.js');

test('doctor produces the complete release-health checklist', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-doctor-'));
  const old = process.env.BLACKBOX_HOME;
  process.env.BLACKBOX_HOME = root;
  try {
    const checks = staticDoctorChecks(join(root, 'blackbox.db'));
    const names = new Set(checks.map((item) => item.name));
    for (const expected of ['Node.js', 'Claude Code', 'State directory', 'Claude hooks', 'Git collector auth', 'Custody anchor', 'Event store', 'Platform']) {
      assert.ok(names.has(expected), `missing doctor check: ${expected}`);
    }
    assert.equal(checks.every((item) => ['pass', 'warn', 'fail'].includes(item.status)), true);
  } finally {
    if (old === undefined) delete process.env.BLACKBOX_HOME;
    else process.env.BLACKBOX_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor byte formatting stays readable', () => {
  assert.equal(formatBytes(42), '42 B');
  assert.equal(formatBytes(2048), '2.00 KB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12.0 MB');
});

test('erase requires explicit --all --yes and removes custom home plus custom database', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-erase-'));
  const home = join(root, 'home');
  const db = join(root, 'outside', 'events.db');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(home, 'signing.key'), 'synthetic');
  writeFileSync(db, 'synthetic');
  writeFileSync(db + '-wal', 'synthetic');
  const env = { ...process.env, BLACKBOX_HOME: home, BLACKBOX_DB: db };
  const cli = join(__dirname, '..', 'dist', 'cli.js');

  try {
    const refused = spawnSync(process.execPath, [cli, 'erase', '--all'], { env, encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(db), true);

    const erased = spawnSync(process.execPath, [cli, 'erase', '--all', '--yes'], { env, encoding: 'utf8' });
    assert.equal(erased.status, 0, erased.stderr);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(db), false);
    assert.equal(existsSync(db + '-wal'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
