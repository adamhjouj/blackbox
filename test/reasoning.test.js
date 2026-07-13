'use strict';
// R1 deep intent: recover the turn's reasoning + model/usage from the transcript,
// store it REDACTED + bounded as a hashed fact, and surface it in the story.
// Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { appendFileSync, mkdirSync, writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readTurnIntent, recoverSessionTurns } = require('../dist/transcript.js');
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

test('read-time recovery scans main + safe sidechains, ignores tool results, redacts, bounds, and caches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-recover-'));
  const main = join(dir, 'S.jsonl');
  const longPrompt = 'fix this with key ' + SECRET + ' ' + '🙂'.repeat(2100);
  const longReasoning = 'agent explanation uses ' + SECRET + ' ' + 'x'.repeat(5000);
  writeFileSync(main, [
    { type: 'user', promptId: 'P1', message: { role: 'user', content: longPrompt } },
    { type: 'assistant', message: { model: 'model-main', usage: { output_tokens: 7 }, content: [{ type: 'text', text: longReasoning }] } },
    { type: 'user', promptId: 'P2', message: { role: 'user', content: [{ type: 'tool_result', content: 'THIS IS OUTPUT, NOT A PROMPT' }] } },
    { type: 'assistant', message: { model: 'model-main', content: [{ type: 'text', text: 'continued after the tool result' }] } },
  ].map(JSON.stringify).join('\n') + '\n');

  const sideDir = join(dir, 'S', 'subagents', 'workflows', 'wf-1');
  mkdirSync(sideDir, { recursive: true });
  writeFileSync(join(sideDir, 'agent-a.jsonl'), [
    { type: 'user', promptId: 'P3', message: { role: 'user', content: [{ type: 'text', text: 'inspect the graph' }] } },
    { type: 'assistant', message: { model: 'model-side', usage: { output_tokens: 3 }, content: [{ type: 'text', text: 'graph inspection complete' }] } },
  ].map(JSON.stringify).join('\n') + '\n');

  const first = recoverSessionTurns(main, 'S');
  const p1 = first.turns.get('P1');
  assert.ok(p1.prompt.includes('[REDACTED'), 'recovered prompt is redacted');
  assert.ok(!p1.prompt.includes(SECRET));
  assert.ok(Array.from(p1.prompt).length <= 2001, 'prompt is code-point bounded plus ellipsis');
  assert.ok(p1.reasoning.includes('[REDACTED'), 'recovered explanation is redacted');
  assert.ok(Array.from(p1.reasoning).length <= 4001, 'reasoning is code-point bounded plus ellipsis');
  assert.equal(first.turns.get('P2').prompt, null, 'tool_result body is never promoted to a prompt');
  assert.match(first.turns.get('P2').reasoning, /continued after the tool result/);
  assert.equal(first.turns.get('P3').prompt, 'inspect the graph', 'local sidechain prompt is recovered');
  assert.strictEqual(recoverSessionTurns(main, 'S'), first, 'unchanged files hit the recovery cache');

  appendFileSync(main, JSON.stringify({ type: 'user', promptId: 'P4', message: { role: 'user', content: 'new prompt' } }) + '\n');
  const changed = recoverSessionTurns(main, 'S');
  assert.notEqual(changed.fingerprint, first.fingerprint, 'file change invalidates the cache');
  assert.equal(changed.turns.get('P4').prompt, 'new prompt');
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

test('sessionStory recovers an old prompt + explanation at read time without mutating the chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-old-turn-'));
  const transcript = join(dir, 'OLD.jsonl');
  writeFileSync(transcript, [
    { type: 'user', promptId: 'P-old', message: { role: 'user', content: 'recover the old prompt' } },
    { type: 'assistant', message: { model: 'model-old', usage: { output_tokens: 9 }, content: [{ type: 'text', text: 'I inspected the old session' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const store = tempStore();
  try {
    const pre = normalizeAndCapture({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/a.ts' }, session_id: 'OLD', tool_use_id: 'tu-old', prompt_id: 'P-old', transcript_path: transcript }, AT);
    const post = normalizeAndCapture({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/r/a.ts' }, tool_response: 'ok', session_id: 'OLD', tool_use_id: 'tu-old', prompt_id: 'P-old', transcript_path: transcript }, AT);
    store.append(pre.event, pre.blob);
    store.append(post.event, post.blob);
    const before = store.events('OLD').length;
    const s = sessionStory(store, 'OLD');
    assert.equal(s.turns.length, 1);
    assert.equal(s.turns[0].prompt, 'recover the old prompt');
    assert.equal(s.turns[0].reasoning, 'I inspected the old session');
    assert.equal(s.turns[0].turn_meta.model, 'model-old');
    assert.equal(s.turns[0].title_source, 'recovered_prompt');
    assert.equal(s.turns[0].display_title, 'recover the old prompt');
    assert.equal(s.turns[0].steps.length, 1);
    assert.equal(store.events('OLD').length, before, 'read-time recovery appends no events');
    assert.ok(verify(store).ok);
  } finally {
    store.cleanup();
  }
});
