'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  GEMINI_HOOK_NAME,
  buildGeminiHookCommand,
  buildGeminiHookConfig,
  initGeminiHooks,
  mergeGeminiHooks,
  readGeminiSettings,
  removeGeminiHooks,
  uninitGeminiHooks,
} = require('../dist/gemini-init.js');
const { GEMINI_HOOK_EVENTS } = require('../dist/adapters/gemini.js');

const NODE = "/opt/Node's/bin/node";
const CLI = '/opt/blackbox recorder/dist/cli.js';

test('Gemini command uses absolute shell-quoted node and CLI paths', () => {
  assert.equal(buildGeminiHookCommand(NODE, CLI), "'/opt/Node'\"'\"'s/bin/node' '/opt/blackbox recorder/dist/cli.js' hook gemini");
  assert.throws(() => buildGeminiHookCommand('node', CLI), /absolute/);
  assert.throws(() => buildGeminiHookCommand(NODE, 'dist/cli.js'), /absolute/);
});

test('Gemini config registers all requested events with named command hooks', () => {
  const cfg = buildGeminiHookConfig('/usr/bin/node', '/opt/blackbox/dist/cli.js');
  assert.deepEqual(Object.keys(cfg), GEMINI_HOOK_EVENTS);
  for (const event of GEMINI_HOOK_EVENTS) {
    const group = cfg[event][0];
    assert.equal(group.matcher, event === 'BeforeTool' || event === 'AfterTool' ? '*' : undefined);
    assert.equal(group.hooks[0].name, GEMINI_HOOK_NAME);
    assert.equal(group.hooks[0].type, 'command');
    assert.equal(group.hooks[0].timeout, 1500);
    assert.equal(group.hooks[0].command, "'/usr/bin/node' '/opt/blackbox/dist/cli.js' hook gemini");
  }
});

test('merge is immutable, idempotent, and preserves unrelated settings and hooks', () => {
  const existing = {
    theme: 'dark',
    hooks: { BeforeTool: [{ matcher: 'write_.*', sequential: true, hooks: [{ name: 'mine', type: 'command', command: '/mine' }] }] },
  };
  const before = JSON.stringify(existing);
  const first = mergeGeminiHooks(existing, '/usr/bin/node', '/opt/bb/cli.js');
  assert.equal(JSON.stringify(existing), before);
  assert.equal(first.settings.theme, 'dark');
  assert.equal(first.settings.hooks.BeforeTool[0].hooks[0].name, 'mine');
  assert.equal(first.settings.hooks.BeforeTool.length, 2);
  assert.deepEqual(first.addedEvents, GEMINI_HOOK_EVENTS);

  const second = mergeGeminiHooks(first.settings, '/usr/bin/node', '/opt/bb/cli.js');
  assert.deepEqual(second.settings, first.settings);
  assert.deepEqual(second.addedEvents, []);
  assert.deepEqual(second.updatedEvents, []);
});

test('merge refreshes stale Blackbox commands without duplicating them', () => {
  const first = mergeGeminiHooks({}, '/old/node', '/old/cli.js').settings;
  // Unknown future Gemini settings on our handler survive a refresh and do not
  // make every subsequent init look changed.
  first.hooks.BeforeAgent[0].hooks[0].futureSetting = true;
  const next = mergeGeminiHooks(first, '/new/node', '/new/cli.js');
  assert.deepEqual(next.addedEvents, []);
  assert.deepEqual(next.updatedEvents, GEMINI_HOOK_EVENTS);
  for (const event of GEMINI_HOOK_EVENTS) {
    const ours = next.settings.hooks[event].flatMap((g) => g.hooks).filter((h) => h.name === GEMINI_HOOK_NAME);
    assert.equal(ours.length, 1);
    assert.match(ours[0].command, /new\/node/);
  }
  const stable = mergeGeminiHooks(next.settings, '/new/node', '/new/cli.js');
  assert.deepEqual(stable.updatedEvents, []);
  assert.equal(stable.settings.hooks.BeforeAgent[0].hooks[0].futureSetting, true);
});

test('remove deletes only named Blackbox hooks', () => {
  const settings = mergeGeminiHooks({ hooks: { BeforeTool: [{ hooks: [{ name: 'mine', type: 'command', command: '/mine' }] }] } }, '/n', '/c').settings;
  const removed = removeGeminiHooks(settings);
  assert.equal(removed.removed, GEMINI_HOOK_EVENTS.length);
  assert.equal(removed.settings.hooks.BeforeTool[0].hooks[0].name, 'mine');
  assert.equal(removed.settings.hooks.AfterTool, undefined);
});

test('filesystem init preserves JSON, makes backups, and uninit restores foreign hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-gemini-init-'));
  const settingsPath = path.join(dir, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const original = { theme: 'dark', hooks: { BeforeAgent: [{ hooks: [{ name: 'mine', type: 'command', command: '/mine' }] }] } };
  fs.writeFileSync(settingsPath, JSON.stringify(original));
  try {
    const result = initGeminiHooks({ settingsPath, nodePath: '/usr/bin/node', cliPath: '/opt/bb/cli.js' });
    assert.ok(result.backupPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.backupPath, 'utf8')), original);
    assert.equal(readGeminiSettings(settingsPath).theme, 'dark');

    const again = initGeminiHooks({ settingsPath, nodePath: '/usr/bin/node', cliPath: '/opt/bb/cli.js' });
    assert.equal(again.backupPath, null);
    assert.deepEqual(again.addedEvents, []);

    const gone = uninitGeminiHooks(settingsPath);
    assert.equal(gone.removed, GEMINI_HOOK_EVENTS.length);
    const final = readGeminiSettings(settingsPath);
    assert.equal(final.theme, 'dark');
    assert.equal(final.hooks.BeforeAgent[0].hooks[0].name, 'mine');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed settings fail closed without backup or replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-gemini-bad-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, '{ nope');
  try {
    assert.throws(
      () => initGeminiHooks({ settingsPath, nodePath: '/usr/bin/node', cliPath: '/opt/bb/cli.js' }),
      /refusing to modify/,
    );
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ nope');
    assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
