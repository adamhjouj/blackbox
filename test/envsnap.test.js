'use strict';
// R7.1 environment snapshot: a rule-inert SessionStart fact fixing the agent's
// capability surface (versions, MCP inventory, hooks + manifest hashes). MCP
// entries are names + command WORD only — never args/env (which carry tokens).
// Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { collectEnv } = require('../dist/envsnap.js');
const { envSnapshotEvent } = require('../dist/normalize.js');
const { verify } = require('../dist/verify.js');
const { tempStore, normEv } = require('./util.js');

function scratchProject() {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-env-'));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  // an MCP server whose args + env carry secrets that must NEVER be captured
  writeFileSync(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        payments: { command: '/usr/local/bin/node', args: ['server.js', '--token', 'SECRETTOKEN123'], env: { API_KEY: 'sk-live-shhhhhhhh' } },
        search: { command: 'npx', args: ['@acme/search-mcp'] },
      },
    }),
  );
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] } }));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'proj', version: '1.0.0' }));
  return cwd;
}

test('collectEnv captures versions, MCP names+command word, and manifest hashes', () => {
  const cwd = scratchProject();
  try {
    const env = collectEnv(cwd);
    assert.equal(env.node_version, process.version);
    assert.ok(env.os && env.os.length > 0);
    // MCP inventory: name + command WORD (basename). The project's servers are
    // present; user-scope servers from the real ~/.claude.json may also appear.
    assert.ok(env.mcp_servers.includes('payments (node)'), `missing payments: ${env.mcp_servers}`);
    assert.ok(env.mcp_servers.includes('search (npx)'), `missing search: ${env.mcp_servers}`);
    assert.deepEqual([...env.mcp_servers].sort(), env.mcp_servers, 'inventory is sorted');
    // project settings contributed a hooks hash + package.json hash
    assert.match(env.hooks_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(env.file_hashes['package.json'], /^sha256:[0-9a-f]{64}$/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP args and env secrets NEVER reach the snapshot', () => {
  const cwd = scratchProject();
  try {
    const blob = JSON.stringify(collectEnv(cwd));
    assert.ok(!blob.includes('SECRETTOKEN123'), 'arg token leaked');
    assert.ok(!blob.includes('sk-live-shhhhhhhh'), 'env secret leaked');
    assert.ok(!blob.includes('server.js'), 'command args leaked');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('collectEnv on a null cwd still yields versions (no crash, no project fields)', () => {
  const env = collectEnv(null);
  assert.equal(env.node_version, process.version);
  assert.deepEqual(env.file_hashes, {});
  assert.ok(Array.isArray(env.mcp_servers));
});

test('envSnapshotEvent has the rule-inert synthetic shape', () => {
  const ev = envSnapshotEvent('S', { node_version: process.version, os: 'x', mcp_servers: [], hooks_hash: null, file_hashes: {} }, '2026-02-01T00:00:00.000Z');
  assert.equal(ev.phase, 'session_start');
  assert.equal(ev.action_type, 'session');
  assert.equal(ev.hook_event, 'EnvSnapshot');
  assert.equal(ev.redaction_count, 0);
  assert.equal(ev.tool_use_id, null);
  assert.ok(JSON.parse(ev.detail).env, 'detail.env present');
});

test('appending an EnvSnapshot keeps the chain valid and is not counted as activity', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'Z', phase: 'session_start', hook_event: 'SessionStart', tool_use_id: null }));
    assert.ok(verify(store).ok);
    store.append(envSnapshotEvent('Z', collectEnv(null), '2026-02-01T00:00:01.000Z'));
    assert.ok(verify(store).ok, 'chain still valid after the snapshot fact');
    assert.equal(store.envSnapshotExists('Z'), true);
    const s = store.sessions().find((x) => x.session_id === 'Z');
    assert.equal(s.activity, 0, 'a session with only lifecycle + env snapshot has zero chat activity');
  } finally {
    store.cleanup();
  }
});
