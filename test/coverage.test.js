'use strict';
// R5.2 coverage ledger: daemon_start / daemon_stop are recorded in the chain, so
// when the recorder was DOWN becomes re-derivable. An unclean prior shutdown (no
// DaemonStop) leaves a gap [last event → next start]. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { daemonStartEvent, daemonStopEvent, DAEMON_SESSION } = require('../dist/normalize.js');
const { verify } = require('../dist/verify.js');
const { tempStore, normEv } = require('./util.js');

test('lifecycle events have the reserved-session synthetic shape', () => {
  const s = daemonStartEvent({ pid: 1, port: 7842, node: 'v20', started: 'T', downtime_from: null, clean: false }, '2026-02-01T00:00:00.000Z');
  assert.equal(s.session_id, DAEMON_SESSION);
  assert.equal(s.phase, 'session_start');
  assert.equal(s.hook_event, 'DaemonStart');
  assert.equal(s.agent_type, 'bb.daemon');
  assert.equal(s.redaction_count, 0);
  const e = daemonStopEvent({ pid: 1, port: 7842 }, '2026-02-01T00:00:09.000Z');
  assert.equal(e.phase, 'session_end');
  assert.equal(e.hook_event, 'DaemonStop');
});

test('lastEventMeta reports the newest event (clean-shutdown detection)', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'A', phase: 'post', hook_event: 'PostToolUse', action_type: 'file_read', target: '/x', ts: '2026-02-01T00:00:01.000Z' }));
    assert.equal(store.lastEventMeta().hook_event, 'PostToolUse');
    store.append(daemonStopEvent({ pid: 1, port: 7842 }, '2026-02-01T00:00:02.000Z'));
    assert.equal(store.lastEventMeta().hook_event, 'DaemonStop', 'a clean stop is now the last event');
  } finally {
    store.cleanup();
  }
});

test('coverageGaps derives the [downtime_from → started] window from DaemonStart', () => {
  const store = tempStore();
  try {
    // a tool event, then the daemon goes down UNCLEANLY (no DaemonStop) and restarts:
    // the startup records downtime_from = the last event's ts.
    store.append(normEv({ session_id: 'A', phase: 'post', hook_event: 'PostToolUse', action_type: 'file_read', target: '/x', ts: '2026-02-01T00:00:05.000Z' }));
    store.append(daemonStartEvent({ pid: 2, port: 7842, node: 'v20', started: '2026-02-01T00:10:00.000Z', downtime_from: '2026-02-01T00:00:05.000Z', clean: false }, '2026-02-01T00:10:00.000Z'));
    const gaps = store.coverageGaps();
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0], { from: '2026-02-01T00:00:05.000Z', to: '2026-02-01T00:10:00.000Z', clean: false });
  } finally {
    store.cleanup();
  }
});

test('a clean restart records a clean gap; a first-ever start records none', () => {
  const store = tempStore();
  try {
    // first start on an empty store → no prior event → no gap
    store.append(daemonStartEvent({ pid: 1, port: 7842, node: 'v20', started: '2026-02-01T00:00:00.000Z', downtime_from: null, clean: false }, '2026-02-01T00:00:00.000Z'));
    assert.equal(store.coverageGaps().length, 0);
    // clean stop, then a later clean start → a KNOWN clean gap
    store.append(daemonStopEvent({ pid: 1, port: 7842 }, '2026-02-01T00:05:00.000Z'));
    store.append(daemonStartEvent({ pid: 3, port: 7842, node: 'v20', started: '2026-02-01T00:06:00.000Z', downtime_from: '2026-02-01T00:05:00.000Z', clean: true }, '2026-02-01T00:06:00.000Z'));
    const gaps = store.coverageGaps();
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].clean, true);
  } finally {
    store.cleanup();
  }
});

test('lifecycle events keep the chain valid and are not chat activity', () => {
  const store = tempStore();
  try {
    store.append(daemonStartEvent({ pid: 1, port: 7842, node: 'v20', started: 'T', downtime_from: null, clean: false }, '2026-02-01T00:00:00.000Z'));
    store.append(daemonStopEvent({ pid: 1, port: 7842 }, '2026-02-01T00:00:09.000Z'));
    assert.ok(verify(store).ok);
    const s = store.sessions().find((x) => x.session_id === DAEMON_SESSION);
    assert.equal(s.activity, 0, 'the bb:daemon session records zero chat activity');
  } finally {
    store.cleanup();
  }
});
