'use strict';
// W0.2 — PreCompact + Notification are now registered hooks and map to their own
// phases, so context-compaction and permission/idle prompts are visible facts.
// They must NOT count as "chat activity" (a lone Notification can't resurrect the
// empty-session cards the rail filter suppresses).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { tempStore, normEv } = require('./util.js');

const AT = '2026-02-01T00:00:00.000Z';
const phaseOf = (hook_event_name, extra = {}) =>
  normalizeAndCapture({ hook_event_name, session_id: 'S', cwd: '/repo', ...extra }, AT).event.phase;

test('PreCompact maps to the compact phase', () => {
  assert.equal(phaseOf('PreCompact', { trigger: 'auto' }), 'compact');
});

test('Notification maps to the notify phase', () => {
  assert.equal(phaseOf('Notification', { message: 'Permission needed to run Bash' }), 'notify');
});

test('a lifecycle-only session (start + notification) records ZERO chat activity', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'Q', phase: 'session_start', hook_event: 'SessionStart', tool_use_id: null }));
    store.append(normEv({ session_id: 'Q', phase: 'notify', hook_event: 'Notification', tool_use_id: null }));
    const s = store.sessions().find((x) => x.session_id === 'Q');
    assert.equal(s.activity, 0, 'notification must not count as activity');
  } finally {
    store.cleanup();
  }
});

test('a real tool call DOES count as activity (control)', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'R', phase: 'session_start', hook_event: 'SessionStart', tool_use_id: null }));
    store.append(normEv({ session_id: 'R', phase: 'post', hook_event: 'PostToolUse', action_type: 'file_read', target: '/repo/a.ts' }));
    const s = store.sessions().find((x) => x.session_id === 'R');
    assert.equal(s.activity, 1);
  } finally {
    store.cleanup();
  }
});
