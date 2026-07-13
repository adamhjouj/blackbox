'use strict';
// R5.3 — record completeness. The transcript is a second ground truth for the
// event stream itself: a completed tool_use absent from the store is a capture
// LOSS, labeled daemon-down (a known coverage gap) or UNEXPLAINED. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readCompletedToolUses } = require('../dist/transcript.js');
const { reconcileCompleteness, persistReconciliation } = require('../dist/reconcile.js');
const { daemonStartEvent } = require('../dist/normalize.js');
const { tempStore, normEv } = require('./util.js');

// Build a transcript .jsonl. `uses` = [{id,name,ts,result}] (result=false → interrupted).
function writeTranscript(dir, records) {
  const lines = [];
  for (const r of records) {
    if (r.server) lines.push(JSON.stringify({ type: 'assistant', timestamp: r.ts, message: { content: [{ type: 'server_tool_use', id: r.id, name: r.name }] } }));
    else lines.push(JSON.stringify({ type: 'assistant', timestamp: r.ts, message: { content: [{ type: 'tool_use', id: r.id, name: r.name }] } }));
    if (r.result) lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: r.id }] } }));
  }
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('readCompletedToolUses returns completed tool_use only (no server_tool_use, no interrupted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-tx-'));
  try {
    const p = writeTranscript(dir, [
      { id: 'toolu_A', name: 'Bash', ts: 'T1', result: true },
      { id: 'toolu_B', name: 'Read', ts: 'T2', result: true },
      { id: 'srv_X', name: 'web_search', ts: 'T3', result: true, server: true }, // excluded: server_tool_use
      { id: 'toolu_C', name: 'Edit', ts: 'T4', result: false }, // excluded: interrupted (no result)
    ]);
    const uses = readCompletedToolUses(p);
    assert.deepEqual(uses.map((u) => u.id).sort(), ['toolu_A', 'toolu_B']);
    assert.equal(uses.find((u) => u.id === 'toolu_A').name, 'Bash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileCompleteness flags a transcript tool call missing from the record as UNEXPLAINED', () => {
  const store = tempStore();
  const dir = mkdtempSync(join(tmpdir(), 'bb-tx-'));
  try {
    const p = writeTranscript(dir, [
      { id: 'toolu_A', name: 'Bash', ts: '2026-02-01T00:01:00.000Z', result: true },
      { id: 'toolu_B', name: 'Read', ts: '2026-02-01T00:02:00.000Z', result: true },
    ]);
    // the store captured only toolu_A (and carries the transcript path on its raw)
    store.append(normEv({ session_id: 'S', tool_use_id: 'toolu_A', phase: 'pre', hook_event: 'PreToolUse', action_type: 'shell_command', target: 'echo', raw: JSON.stringify({ transcript_path: p }) }));
    const c = reconcileCompleteness(store, 'S');
    assert.equal(c.transcript_tool_uses, 2);
    assert.equal(c.recorded, 1);
    assert.equal(c.missing.length, 1);
    assert.equal(c.missing[0].id, 'toolu_B');
    assert.equal(c.missing[0].explained, 'unexplained');
    assert.equal(c.coverage_ratio, 0.5);
  } finally {
    store.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a miss inside a daemon-down window is explained, not unexplained', () => {
  const store = tempStore();
  const dir = mkdtempSync(join(tmpdir(), 'bb-tx-'));
  try {
    const p = writeTranscript(dir, [
      { id: 'toolu_A', name: 'Bash', ts: '2026-02-01T00:01:00.000Z', result: true },
      { id: 'toolu_B', name: 'Read', ts: '2026-02-01T00:05:00.000Z', result: true }, // falls in the gap below
    ]);
    store.append(normEv({ session_id: 'S', tool_use_id: 'toolu_A', phase: 'pre', hook_event: 'PreToolUse', action_type: 'shell_command', target: 'echo', raw: JSON.stringify({ transcript_path: p }) }));
    // a recorder-down window covering toolu_B's timestamp
    store.append(daemonStartEvent({ pid: 1, port: 7842, node: 'v20', started: '2026-02-01T00:06:00.000Z', downtime_from: '2026-02-01T00:04:00.000Z', clean: false }, '2026-02-01T00:06:00.000Z'));
    const c = reconcileCompleteness(store, 'S');
    assert.equal(c.missing.length, 1);
    assert.equal(c.missing[0].explained, 'daemon-down', 'the miss is inside a known coverage gap');
  } finally {
    store.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fully-captured session is complete (ratio 1, no missing)', () => {
  const store = tempStore();
  const dir = mkdtempSync(join(tmpdir(), 'bb-tx-'));
  try {
    const p = writeTranscript(dir, [{ id: 'toolu_A', name: 'Bash', ts: 'T1', result: true }]);
    store.append(normEv({ session_id: 'S', tool_use_id: 'toolu_A', phase: 'pre', hook_event: 'PreToolUse', action_type: 'shell_command', target: 'echo', raw: JSON.stringify({ transcript_path: p }) }));
    const c = reconcileCompleteness(store, 'S');
    assert.equal(c.coverage_ratio, 1);
    assert.equal(c.missing.length, 0);
  } finally {
    store.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistReconciliation folds completeness into the coverage blob', () => {
  const store = tempStore();
  const dir = mkdtempSync(join(tmpdir(), 'bb-tx-'));
  try {
    const p = writeTranscript(dir, [
      { id: 'toolu_A', name: 'Bash', ts: 'T1', result: true },
      { id: 'toolu_B', name: 'Read', ts: 'T2', result: true },
    ]);
    store.append(normEv({ session_id: 'S', tool_use_id: 'toolu_A', phase: 'pre', hook_event: 'PreToolUse', action_type: 'shell_command', target: 'echo', raw: JSON.stringify({ transcript_path: p }) }));
    const r = persistReconciliation(store, 'S', '2026-02-01T00:10:00.000Z');
    assert.ok(r.coverage.completeness, 'completeness present on the returned coverage');
    assert.equal(r.coverage.completeness.recorded, 1);
    // and it round-trips through the persisted row
    const row = store.sessionReconciliation('S', 'v1');
    const persisted = JSON.parse(row.coverage).completeness;
    assert.equal(persisted.transcript_tool_uses, 2);
  } finally {
    store.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
