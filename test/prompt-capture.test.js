'use strict';
// Provenance capture: the UserPromptSubmit prompt (the turn's intent) and the
// subagent parent link ride in the hashed `detail` — REDACTED before persistence,
// and hash-neutral to every event that doesn't carry them. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { tempStore } = require('./util.js');

const AT = '2026-02-01T00:00:00.000Z';
let TU = 0;

function promptPayload(text, extra = {}) {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'S',
    prompt_id: 'P1',
    cwd: '/repo',
    user_input: text,
    ...extra,
  };
}
function editPayload(file_path, old_string, new_string, extra = {}) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path, old_string, new_string },
    session_id: 'S',
    tool_use_id: 'tu' + ++TU,
    prompt_id: 'P1',
    cwd: '/repo',
    ...extra,
  };
}
const detailOf = (payload) => {
  const { event } = normalizeAndCapture(payload, AT);
  return event.detail ? JSON.parse(event.detail) : {};
};

// ---- prompt capture (both field names) -----------------------------------
test('a UserPromptSubmit becomes a `prompt`-phase event carrying the prompt text', () => {
  const { event } = normalizeAndCapture(promptPayload('fix the session-expiry bug'), AT);
  assert.equal(event.phase, 'prompt');
  assert.equal(event.prompt_id, 'P1');
  assert.equal(JSON.parse(event.detail).prompt, 'fix the session-expiry bug');
});

test('the prompt field name is tolerated as `prompt` too (version drift)', () => {
  const d = detailOf({ hook_event_name: 'UserPromptSubmit', session_id: 'S', prompt_id: 'P1', prompt: 'legacy field name' });
  assert.equal(d.prompt, 'legacy field name');
});

test('a very long prompt is bounded (intent kept, no unbounded bloat)', () => {
  const big = 'x'.repeat(5000);
  const d = detailOf(promptPayload(big));
  assert.ok(d.prompt.length < 2100, 'prompt should be truncated');
  assert.ok(d.prompt.endsWith('…'), 'truncation marker expected');
});

// ---- REDACTION before persistence (a secret pasted into a prompt) ---------
test('a secret pasted into a prompt is redacted before it touches detail or raw', () => {
  const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const { event } = normalizeAndCapture(promptPayload('here is my key ' + key + ' please use it'), AT);
  const d = JSON.parse(event.detail);
  assert.ok(d.prompt.includes('[REDACTED'), 'expected a [REDACTED marker in the prompt');
  assert.ok(!d.prompt.includes(key), 'secret leaked into detail.prompt');
  assert.ok(!event.raw.includes(key), 'secret leaked into raw');
  assert.ok(event.redaction_count >= 1);
});

test('the legacy `prompt` field name is redacted too', () => {
  const key = 'sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210';
  const { event } = normalizeAndCapture(
    { hook_event_name: 'UserPromptSubmit', session_id: 'S', prompt_id: 'P1', prompt: 'key ' + key },
    AT,
  );
  assert.ok(!event.raw.includes(key), 'secret leaked into raw under the prompt field');
});

// ---- subagent parent link ------------------------------------------------
test('a subagent event carries parent_tool_use_id when present', () => {
  const d = detailOf(editPayload('/repo/a.ts', 'x', 'y', { agent_id: 'ag1', agent_type: 'Explore', parent_tool_use_id: 'task_42' }));
  assert.equal(d.parent_tool_use_id, 'task_42');
});

test('a normal event without a parent link carries no parent key (hash-neutral)', () => {
  const d = detailOf(editPayload('/repo/a.ts', 'x', 'y'));
  assert.equal('parent_tool_use_id' in d, false);
});

// ---- hash-neutrality: prompt/parent are additive, earlier rows unchanged ---
test('adding a prompt event does not change earlier events\' hashes', () => {
  const store = tempStore();
  try {
    const a = normalizeAndCapture(editPayload('/repo/a.ts', 'a1', 'a2'), AT);
    const first = store.append(a.event, a.blob);
    const h1 = store.get(first.seq).hash;

    // A prompt event and a parent-linked subagent event append AFTER — append-only.
    const p = normalizeAndCapture(promptPayload('do the thing'), AT);
    store.append(p.event, p.blob);
    const c = normalizeAndCapture(editPayload('/repo/c.ts', 'c1', 'c2', { parent_tool_use_id: 'task_1' }), AT);
    store.append(c.event, c.blob);

    // The earlier event's hash is byte-identical — the new detail keys touch only
    // the rows that carry them (canonical() omits absent keys).
    assert.equal(store.get(first.seq).hash, h1);
    const { verify } = require('../dist/verify.js');
    assert.ok(verify(store).ok);
  } finally {
    store.cleanup();
  }
});
