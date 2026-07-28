'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CODEX_HOOK_EVENTS } = require('../dist/adapters/codex.js');
const {
  buildCodexHookCommand,
  buildCodexHookConfig,
  initCodexHooks,
  mergeCodexHooks,
  readCodexHooks,
  removeCodexHooks,
  rollbackCodexInit,
  uninitCodexHooks,
} = require('../dist/codex-init.js');

const NODE = "/opt/Node's/bin/node";
const CLI = '/opt/blackbox recorder/dist/cli.js';

test('Codex command uses absolute shell-quoted durable paths', () => {
  assert.equal(buildCodexHookCommand(NODE, CLI), "'/opt/Node'\"'\"'s/bin/node' '/opt/blackbox recorder/dist/cli.js' hook codex");
  assert.throws(() => buildCodexHookCommand('node', CLI), /absolute/);
  assert.throws(() => buildCodexHookCommand(NODE, 'dist/cli.js'), /absolute/);
});

test('Codex config registers every supported lifecycle event within timeout limits', () => {
  const cfg = buildCodexHookConfig('/usr/bin/node', '/opt/blackbox/dist/cli.js');
  assert.deepEqual(Object.keys(cfg), CODEX_HOOK_EVENTS);
  for (const event of CODEX_HOOK_EVENTS) {
    const group = cfg[event][0];
    assert.equal(group.matcher, undefined);
    assert.deepEqual(group.hooks[0], {
      type: 'command',
      command: "'/usr/bin/node' '/opt/blackbox/dist/cli.js' hook codex",
      timeout: 3,
    });
  }
  assert.throws(() => buildCodexHookConfig('/n', '/c', 4), /1 to 3/);
});

test('Codex merge is immutable, idempotent, and preserves unrelated hooks', () => {
  const existing = {
    custom: true,
    hooks: { PreToolUse: [{ matcher: '^Bash$', future: 1, hooks: [{ type: 'command', command: '/mine', timeout: 9 }] }] },
  };
  const before = JSON.stringify(existing);
  const first = mergeCodexHooks(existing, '/usr/bin/node', '/opt/bb/cli.js');
  assert.equal(JSON.stringify(existing), before);
  assert.equal(first.file.custom, true);
  assert.equal(first.file.hooks.PreToolUse[0].hooks[0].command, '/mine');
  assert.equal(first.file.hooks.PreToolUse.length, 2);
  assert.deepEqual(first.addedEvents, CODEX_HOOK_EVENTS);

  const second = mergeCodexHooks(first.file, '/usr/bin/node', '/opt/bb/cli.js');
  assert.deepEqual(second.file, first.file);
  assert.deepEqual(second.addedEvents, []);
  assert.deepEqual(second.updatedEvents, []);
});

test('Codex merge refreshes stale Blackbox commands without duplication', () => {
  const first = mergeCodexHooks({}, '/old/node', '/old/cli.js').file;
  first.hooks.PreToolUse[0].hooks[0].futureSetting = true;
  const next = mergeCodexHooks(first, '/new/node', '/new/cli.js');
  assert.deepEqual(next.addedEvents, []);
  assert.deepEqual(next.updatedEvents, CODEX_HOOK_EVENTS);
  for (const event of CODEX_HOOK_EVENTS) {
    const ours = next.file.hooks[event].flatMap((group) => group.hooks).filter((hook) => /hook codex/.test(hook.command));
    assert.equal(ours.length, 1);
    assert.match(ours[0].command, /new\/node/);
  }
  assert.equal(next.file.hooks.PreToolUse[0].hooks[0].futureSetting, true);
});

test('Codex removal deletes only Blackbox command hooks', () => {
  const file = mergeCodexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/mine' }] }] } }, '/n', '/c').file;
  const removed = removeCodexHooks(file);
  assert.equal(removed.removed, CODEX_HOOK_EVENTS.length);
  assert.equal(removed.file.hooks.Stop[0].hooks[0].command, '/mine');
  assert.equal(removed.file.hooks.SessionEnd, undefined);
});

test('Codex filesystem init backs up, rolls back, and uninstalls safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-codex-init-'));
  const hooksPath = path.join(dir, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/mine' }] }] } };
  fs.writeFileSync(hooksPath, JSON.stringify(original));
  try {
    const result = initCodexHooks({ hooksPath, nodePath: '/usr/bin/node', cliPath: '/opt/bb/cli.js' });
    assert.ok(result.backupPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.backupPath, 'utf8')), original);
    assert.equal(readCodexHooks(hooksPath).hooks.Stop.length, 2);

    rollbackCodexInit(result);
    assert.deepEqual(readCodexHooks(hooksPath), original);

    const installed = initCodexHooks({ hooksPath, nodePath: '/usr/bin/node', cliPath: '/opt/bb/cli.js' });
    const again = initCodexHooks({ hooksPath, nodePath: '/usr/bin/node', cliPath: '/opt/bb/cli.js' });
    assert.ok(installed.backupPath);
    assert.equal(again.backupPath, null);
    const gone = uninitCodexHooks(hooksPath);
    assert.equal(gone.removed, CODEX_HOOK_EVENTS.length);
    assert.deepEqual(readCodexHooks(hooksPath), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex malformed hook files fail closed without replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-codex-bad-'));
  const hooksPath = path.join(dir, 'hooks.json');
  fs.writeFileSync(hooksPath, '{ nope');
  try {
    assert.throws(() => initCodexHooks({ hooksPath, nodePath: '/n', cliPath: '/c' }), /refusing to modify/);
    assert.equal(fs.readFileSync(hooksPath, 'utf8'), '{ nope');
    assert.deepEqual(fs.readdirSync(dir), ['hooks.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
