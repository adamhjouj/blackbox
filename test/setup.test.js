'use strict';
// Packaging / one-command setup. Filesystem tests use isolated temporary paths;
// nothing here touches ~/.claude, ~/.blackbox, or launchctl.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildHookConfig, mergeHooks, readClaudeSettings, writeClaudeSettings } = require('../dist/init.js');
const { buildLaunchAgentPlist } = require('../dist/autostart.js');

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const OTHER_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Notification'];

// ---- buildHookConfig: shape --------------------------------------------------

test('buildHookConfig: registers every tool + lifecycle event', () => {
  const cfg = buildHookConfig(7842);
  assert.deepEqual(Object.keys(cfg), [...TOOL_EVENTS, ...OTHER_EVENTS]);
});

test('buildHookConfig: every handler is an async http hook on the loopback /hook url', () => {
  const cfg = buildHookConfig(7842);
  for (const groups of Object.values(cfg)) {
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hooks.length, 1);
    const h = groups[0].hooks[0];
    assert.equal(h.type, 'http');
    assert.equal(h.async, true);
    assert.equal(h.url, 'http://127.0.0.1:7842/hook');
    // timeout is in SECONDS (Claude Code's unit), never milliseconds.
    assert.equal(h.timeout, 5);
  }
});

test('buildHookConfig: tool events carry a "*" matcher, lifecycle events do not', () => {
  const cfg = buildHookConfig(7842);
  for (const e of TOOL_EVENTS) assert.equal(cfg[e][0].matcher, '*');
  for (const e of OTHER_EVENTS) assert.equal('matcher' in cfg[e][0], false);
});

test('buildHookConfig: the port flows into the url', () => {
  const cfg = buildHookConfig(9001);
  assert.equal(cfg.PostToolUse[0].hooks[0].url, 'http://127.0.0.1:9001/hook');
  assert.equal(cfg.SessionStart[0].hooks[0].url, 'http://127.0.0.1:9001/hook');
});

// ---- mergeHooks: correctness + idempotency ----------------------------------

test('mergeHooks: into empty settings registers all nine events', () => {
  const { settings, addedEvents } = mergeHooks({}, 7842);
  assert.deepEqual(addedEvents, [...TOOL_EVENTS, ...OTHER_EVENTS]);
  assert.deepEqual(Object.keys(settings.hooks), [...TOOL_EVENTS, ...OTHER_EVENTS]);
});

test('mergeHooks: is idempotent — merging twice equals merging once', () => {
  const once = mergeHooks({}, 7842);
  const twice = mergeHooks(once.settings, 7842);
  assert.deepEqual(twice.settings, once.settings); // no duplicate hooks, byte-identical
  assert.deepEqual(twice.addedEvents, []); // second run adds nothing
});

test('mergeHooks: re-merging a hand-written settings file is a no-op', () => {
  // Simulate a settings.json already carrying our block, then merge again.
  const base = mergeHooks({}, 7842).settings;
  const again = mergeHooks(structuredClone(base), 7842);
  assert.deepEqual(again.settings, base);
  assert.deepEqual(again.addedEvents, []);
});

test('mergeHooks: never clobbers a pre-existing foreign hook on the same event', () => {
  const existing = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
  };
  const { settings, addedEvents } = mergeHooks(existing, 7842);
  assert.ok(addedEvents.includes('PreToolUse'));
  // The user's group survives, ours is appended alongside it.
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo hi');
  assert.equal(settings.hooks.PreToolUse[1].hooks[0].url, 'http://127.0.0.1:7842/hook');
});

test('mergeHooks: does not append a second blackbox hook when one is already present', () => {
  const first = mergeHooks({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }, 7842);
  const second = mergeHooks(first.settings, 7842);
  assert.deepEqual(second.settings, first.settings);
  assert.equal(second.settings.hooks.PreToolUse.length, 2); // still just foreign + one blackbox
  assert.equal(second.addedEvents.length, 0);
});

test('mergeHooks: migrates every existing Blackbox hook when the daemon port changes', () => {
  const first = mergeHooks({}, 7842);
  const moved = mergeHooks(first.settings, 7999);
  assert.deepEqual(moved.addedEvents, []);
  assert.equal(moved.updatedEvents.length, Object.keys(first.settings.hooks).length);
  for (const groups of Object.values(moved.settings.hooks)) {
    const urls = groups.flatMap((group) => group.hooks).filter((hook) => hook.type === 'http').map((hook) => hook.url);
    assert.deepEqual(urls, ['http://127.0.0.1:7999/hook']);
  }
});

test('mergeHooks: preserves unrelated top-level settings keys', () => {
  const { settings } = mergeHooks({ model: 'opus', permissions: { allow: ['Bash'] } }, 7842);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions, { allow: ['Bash'] });
});

test('mergeHooks: does not mutate the input settings object', () => {
  const input = { hooks: {} };
  const before = JSON.stringify(input);
  mergeHooks(input, 7842);
  assert.equal(JSON.stringify(input), before);
});

test('Claude settings reject malformed and non-object JSON without modifying it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-claude-bad-'));
  try {
    for (const [index, raw] of ['{ nope', '[]', 'null', '"string"'].entries()) {
      const settingsPath = path.join(dir, `settings-${index}.json`);
      fs.writeFileSync(settingsPath, raw);
      assert.throws(() => readClaudeSettings(settingsPath), /refusing to modify/);
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), raw);
    }
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('blackbox-bak')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude settings writes are atomic with private, versioned, no-clobber backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-claude-settings-'));
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const original = '{"theme":"dark"}\n';
  fs.writeFileSync(settingsPath, original, { mode: 0o644 });
  try {
    const first = writeClaudeSettings(settingsPath, { theme: 'light' });
    assert.equal(first, `${settingsPath}.blackbox-bak`);
    assert.equal(fs.readFileSync(first, 'utf8'), original);
    assert.equal(fs.statSync(first).mode & 0o777, 0o600);
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);

    const firstWritten = fs.readFileSync(settingsPath, 'utf8');
    const second = writeClaudeSettings(settingsPath, { theme: 'system' });
    assert.equal(second, `${settingsPath}.blackbox-bak.2`);
    assert.equal(fs.readFileSync(first, 'utf8'), original);
    assert.equal(fs.readFileSync(second, 'utf8'), firstWritten);
    assert.equal(fs.statSync(second).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- buildLaunchAgentPlist: pure macOS autostart generator ------------------

test('buildLaunchAgentPlist: emits a KeepAlive/RunAtLoad agent that runs the daemon', () => {
  const plist = buildLaunchAgentPlist({
    nodePath: '/usr/local/bin/node',
    cliPath: '/opt/blackbox/dist/cli.js',
    port: 7842,
    logFile: '/Users/dev/.blackbox/daemon.log',
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.blackbox\.daemon<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.ok(plist.includes('<string>/usr/local/bin/node</string>'));
  assert.ok(plist.includes('<string>/opt/blackbox/dist/cli.js</string>'));
  assert.ok(plist.includes('<string>start</string>'));
  assert.ok(plist.includes('<string>--foreground</string>'));
  assert.ok(plist.includes('<string>7842</string>'));
  assert.ok(plist.includes('<string>/Users/dev/.blackbox/daemon.log</string>'));
});

test('buildLaunchAgentPlist: includes --db only when a db path is given', () => {
  const withDb = buildLaunchAgentPlist({ nodePath: 'node', cliPath: 'cli.js', port: 7842, logFile: 'l', db: '/data/bb.db' });
  assert.ok(withDb.includes('<string>--db</string>'));
  assert.ok(withDb.includes('<string>/data/bb.db</string>'));
  const noDb = buildLaunchAgentPlist({ nodePath: 'node', cliPath: 'cli.js', port: 7842, logFile: 'l' });
  assert.equal(noDb.includes('<string>--db</string>'), false);
});

test('buildLaunchAgentPlist: xml-escapes paths containing & < >', () => {
  const plist = buildLaunchAgentPlist({ nodePath: 'node', cliPath: '/a & b/<cli>.js', port: 7842, logFile: 'l' });
  assert.ok(plist.includes('/a &amp; b/&lt;cli&gt;.js'));
  assert.equal(plist.includes('/a & b/<cli>.js'), false);
});
