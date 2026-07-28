'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const cli = join(__dirname, '..', 'dist', 'cli.js');

test('Gemini command bridge always returns the exact non-blocking allow response', () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-gemini-hook-cli-'));
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'test-token-123456', port: 9 }));
    const result = spawnSync(process.execPath, [cli, 'hook', 'gemini'], {
      env: { ...process.env, BLACKBOX_HOME: home },
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'S1' }),
      encoding: 'utf8',
      timeout: 3_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{}');
    assert.equal(result.stderr, '');

    writeFileSync(join(home, 'config.json'), '{ malformed');
    const degraded = spawnSync(process.execPath, [cli, 'hook', 'gemini'], {
      env: { ...process.env, BLACKBOX_HOME: home },
      input: '{}',
      encoding: 'utf8',
      timeout: 3_000,
    });
    assert.equal(degraded.status, 0);
    assert.equal(degraded.stdout, '{}');
    assert.equal(degraded.stderr, '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
