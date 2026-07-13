'use strict';
// R5.1 — anti-forensics detection (ruleset r3). The recorder-tamper flag (score 80
// ⇒ HIGH alone) + the anti-forensics combo fire when the AGENT attacks the recorder:
// ~/.blackbox, the daemon, its hooks, or `blackbox stop|uninit|prune`. FIXED-TEXT
// matching only (re-derivable). Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateEvent, newRuleCtx, isRecorderTamper } = require('../dist/risk-rules.js');
const { computeSession } = require('../dist/risk-engine.js');
const { ev, normEv, tempStore } = require('./util.js');

const hit = (o, rs = 'r3') => evaluateEvent(ev(1, o), newRuleCtx(), rs).find((h) => h.flag === 'recorder-tamper');
const fires = (o, rs = 'r3') => !!hit(o, rs);

// ---- fire cases: the agent attacking the recorder --------------------------
const ATTACKS = [
  ['rm the store', { action_type: 'shell_command', target: 'rm -rf ~/.blackbox/blackbox.db' }],
  ['sqlite3 the store', { action_type: 'shell_command', target: 'sqlite3 ~/.blackbox/blackbox.db "DELETE FROM events WHERE seq > 5"' }],
  ['overwrite the signing key', { action_type: 'file_write', target: '/Users/x/.blackbox/signing.key' }],
  ['edit the hooks settings', { action_type: 'file_edit', target: '/Users/x/.claude/settings.json' }],
  ['edit the local hooks settings', { action_type: 'file_edit', target: '/Users/x/.claude/settings.local.json' }],
  ['kill the daemon (pkill)', { action_type: 'shell_command', target: 'pkill -f blackbox' }],
  ['launchctl bootout the agent', { action_type: 'shell_command', target: 'launchctl bootout gui/501 com.blackbox.daemon' }],
  ['blackbox stop by the agent', { action_type: 'shell_command', target: 'blackbox stop' }],
  ['blackbox prune by the agent', { action_type: 'shell_command', target: 'blackbox prune --older-than 1d' }],
  ['delete the git-forensics hook', { action_type: 'shell_command', target: 'rm .git/hooks/reference-transaction' }],
  ['move core.hooksPath away', { action_type: 'shell_command', target: 'git config core.hooksPath /dev/null' }],
  ['$BLACKBOX_HOME redirect', { action_type: 'shell_command', target: 'rm -rf $BLACKBOX_HOME' }],
];
for (const [label, o] of ATTACKS) {
  test(`recorder-tamper FIRES: ${label}`, () => {
    const h = hit(o);
    assert.ok(h, `expected recorder-tamper for ${o.target}`);
    assert.equal(h.score, 80, 'recorder-tamper is a top-tier flag');
  });
}

// ---- negative controls -----------------------------------------------------
const SAFE = [
  ['similarly-named dir', { action_type: 'file_edit', target: '/Users/x/.blackboxy/notes.md' }],
  ['a source file named blackbox', { action_type: 'file_edit', target: 'src/blackbox.ts' }],
  ['READING the store is not tampering', { action_type: 'file_read', target: '/Users/x/.blackbox/blackbox.db' }],
  ['plain git config', { action_type: 'shell_command', target: 'git config user.name Bob' }],
  ['the word blackbox in an echo', { action_type: 'shell_command', target: 'echo blackbox recorder is running' }],
  ['a normal settings file elsewhere', { action_type: 'file_edit', target: '/Users/x/project/settings.json' }],
];
for (const [label, o] of SAFE) {
  test(`recorder-tamper does NOT fire: ${label}`, () => assert.equal(fires(o), false));
}

// ---- version gating: r3-only ----------------------------------------------
test('recorder-tamper is r3-only (r1/r2 never fire it — replay stays byte-identical)', () => {
  const o = { action_type: 'shell_command', target: 'blackbox stop' };
  assert.equal(fires(o, 'r1'), false);
  assert.equal(fires(o, 'r2'), false);
  assert.equal(fires(o, 'r3'), true);
  assert.ok(isRecorderTamper(ev(1, o)), 'the predicate itself is version-agnostic; gating is in evaluateEvent');
});

// ---- combo + verdict -------------------------------------------------------
test('a recorder-tamper event scores the session HIGH with an anti-forensics combo (r3)', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'T', action_type: 'shell_command', target: 'sqlite3 ~/.blackbox/blackbox.db "DELETE FROM events"' }));
    const { verdict } = computeSession(store, 'T', 'r3');
    assert.equal(verdict.verdict, 'high');
    assert.ok(verdict.combos.some((c) => c.id === 'anti-forensics'), 'anti-forensics combo should fire');
    assert.equal(verdict.rule_counts['recorder-tamper'], 1);
  } finally {
    store.cleanup();
  }
});

test('the SAME session under r2 is not flagged as tampering (contrast)', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'T2', action_type: 'shell_command', target: 'sqlite3 ~/.blackbox/blackbox.db "DELETE FROM events"' }));
    const { verdict } = computeSession(store, 'T2', 'r2');
    assert.ok(!verdict.combos.some((c) => c.id === 'anti-forensics'), 'r2 knows nothing of anti-forensics');
    assert.equal(verdict.rule_counts['recorder-tamper'] ?? 0, 0);
  } finally {
    store.cleanup();
  }
});
