'use strict';
// R1 deep intent: recover the turn's reasoning + model/usage from the transcript,
// store it REDACTED + bounded as a hashed fact, and surface it in the story.
// Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readTurnIntent } = require('../dist/transcript.js');
const { reasoningEvent, normalizeAndCapture } = require('../dist/normalize.js');
const { sessionStory } = require('../dist/read-api.js');
const { verify } = require('../dist/verify.js');
const { tempStore } = require('./util.js');

const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const AT = '2026-02-01T00:00:00.000Z';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bb-tx-'));
  const path = join(dir, 't.jsonl');
  // Realistic shape: only USER records carry promptId; assistant records don't —
  // they belong to the most recent user turn.
  const lines = [
    { type: 'user', promptId: 'P1', message: { role: 'user', content: 'fix the config' } },
    { type: 'assistant', message: { model: 'claude-fable-5', stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'thinking', thinking: 'I should edit the config', signature: 'sig-should-be-dropped' }] } },
    { type: 'user', promptId: 'P1', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { model: 'claude-fable-5', stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 30 }, content: [{ type: 'thinking', thinking: 'done, key is ' + SECRET }, { type: 'text', text: 'ok' }] } },
    { type: 'user', promptId: 'P2', message: { role: 'user', content: 'another' } },
    { type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'thinking', thinking: 'different turn' }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

test('readTurnIntent extracts thinking + model/usage for a turn, dropping the signature', () => {
  const intent = readTurnIntent(fixture(), 'P1');
  assert.equal(intent.promptId, 'P1');
  assert.ok(intent.reasoning.includes('I should edit the config'));
  assert.ok(intent.reasoning.includes('done, key is'));
  assert.ok(!intent.reasoning.includes('sig-should-be-dropped'), 'thinking signature must be dropped');
  assert.equal(intent.model, 'claude-fable-5');
  assert.equal(intent.stop_reason, 'end_turn');
  assert.equal(intent.usage.input_tokens, 220); // summed across the turn
  assert.equal(intent.usage.output_tokens, 80);
  assert.equal(intent.assistant_messages, 2);
});

test('readTurnIntent with no promptId uses the last turn; unknown/missing → null', () => {
  const p = fixture();
  assert.equal(readTurnIntent(p).promptId, 'P2'); // last assistant record
  assert.equal(readTurnIntent(p, 'NOPE'), null);
  assert.equal(readTurnIntent('/no/such/file.jsonl'), null);
});

test('reasoningEvent redacts a secret in the reasoning before persistence', () => {
  const intent = readTurnIntent(fixture(), 'P1');
  const ev = reasoningEvent('S', intent, AT);
  assert.equal(ev.phase, 'reasoning');
  assert.equal(ev.hook_event, 'ReasoningCapture');
  assert.equal(ev.prompt_id, 'P1');
  const d = JSON.parse(ev.detail);
  assert.ok(d.reasoning.includes('[REDACTED'), 'reasoning should be redacted');
  assert.ok(!ev.detail.includes(SECRET), 'secret leaked into detail');
  assert.ok(!ev.raw.includes(SECRET), 'secret leaked into raw');
  assert.equal(d.turn_meta.model, 'claude-fable-5');
  assert.equal(d.turn_meta.usage.output_tokens, 80);
});

const rEvent = (pid, text) => reasoningEvent('S', { promptId: pid, reasoning: text, model: 'm', usage: null, stop_reason: null, assistant_messages: 1 }, AT);

test('a reasoning event attaches to its turn even when a later turn is current (out of order)', () => {
  const store = tempStore();
  try {
    const p1 = normalizeAndCapture({ hook_event_name: 'UserPromptSubmit', session_id: 'S', prompt_id: 'P1', user_input: 'turn one' }, AT);
    store.append(p1.event);
    const e1 = normalizeAndCapture({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }, session_id: 'S', tool_use_id: 't1', prompt_id: 'P1' }, AT);
    store.append(e1.event, e1.blob);
    const p2 = normalizeAndCapture({ hook_event_name: 'UserPromptSubmit', session_id: 'S', prompt_id: 'P2', user_input: 'turn two' }, AT);
    store.append(p2.event);
    const e2 = normalizeAndCapture({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/b.ts', old_string: 'x', new_string: 'y' }, session_id: 'S', tool_use_id: 't2', prompt_id: 'P2' }, AT);
    store.append(e2.event, e2.blob);
    // reasoning for P1 appended AFTER all of P2 (higher seq) — must still land on turn 1
    store.append(rEvent('P1', 'why turn one'));
    assert.ok(verify(store).ok);
    const s = sessionStory(store, 'S');
    assert.equal(s.turns.length, 2);
    assert.ok(s.turns[0].reasoning && s.turns[0].reasoning.includes('why turn one'));
    assert.equal(s.turns[1].reasoning, null); // turn 2 got none
  } finally {
    store.cleanup();
  }
});

test('reasoningExists dedups per (session, turn) — one reasoning event per turn', () => {
  const store = tempStore();
  try {
    store.append(rEvent('P1', 'r'));
    assert.equal(store.reasoningExists('S', 'P1'), true);
    assert.equal(store.reasoningExists('S', 'P2'), false);
    assert.equal(store.reasoningExists('OTHER', 'P1'), false);
  } finally {
    store.cleanup();
  }
});

test('the story surfaces reasoning + model on the turn (not as a step); hash-neutral', () => {
  const store = tempStore();
  try {
    // prompt opens the turn
    const p = normalizeAndCapture({ hook_event_name: 'UserPromptSubmit', session_id: 'S', prompt_id: 'P1', user_input: 'fix the config' }, AT);
    store.append(p.event, p.blob);
    // a tool step in the turn
    const e = normalizeAndCapture({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/cfg.ts', old_string: 'a', new_string: 'b' }, session_id: 'S', tool_use_id: 'tu1', prompt_id: 'P1' }, AT);
    const editStored = store.append(e.event, e.blob);
    const h1 = store.get(editStored.seq).hash;

    // reasoning event appended after (async in prod)
    const intent = readTurnIntent(fixture(), 'P1');
    store.append(reasoningEvent('S', intent, AT));

    // earlier event hash unchanged; chain still verifies
    assert.equal(store.get(editStored.seq).hash, h1);
    assert.ok(verify(store).ok);

    const s = sessionStory(store, 'S');
    assert.equal(s.turns.length, 1);
    assert.ok(s.turns[0].reasoning && s.turns[0].reasoning.includes('edit the config'));
    assert.equal(s.turns[0].turn_meta.model, 'claude-fable-5');
    // reasoning is NOT a step — the only step is the edit
    assert.equal(s.turns[0].steps.length, 1);
    assert.equal(s.turns[0].steps[0].target, '/r/cfg.ts');
  } finally {
    store.cleanup();
  }
});
