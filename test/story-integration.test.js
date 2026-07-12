'use strict';
// End-to-end (module level): realistic hook payloads → normalizeAndCapture →
// store.append → sessionStory. Proves the whole provenance pipeline joins up:
// a UserPromptSubmit's intent, the turn's tool steps, and the files they changed —
// exactly what the daemon does per hook, minus the HTTP hop. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { sessionStory } = require('../dist/read-api.js');
const { verify } = require('../dist/verify.js');
const { tempStore } = require('./util.js');

const SID = 'e2e-sess';
let T = 0;
function ingest(store, payload) {
  const { event, blob } = normalizeAndCapture(payload, '2026-02-01T00:00:0' + (T++ % 10) + '.000Z');
  return store.append(event, blob);
}
const prompt = (prompt_id, text) => ({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt_id, cwd: '/repo', user_input: text, transcript_path: '/tmp/x.jsonl' });
const editPre = (prompt_id, tu, file, oldS, newS) => ({ hook_event_name: 'PreToolUse', session_id: SID, prompt_id, tool_use_id: tu, tool_name: 'Edit', tool_input: { file_path: file, old_string: oldS, new_string: newS }, cwd: '/repo' });
const editPost = (prompt_id, tu, file, oldS, newS) => ({ hook_event_name: 'PostToolUse', session_id: SID, prompt_id, tool_use_id: tu, tool_name: 'Edit', tool_input: { file_path: file, old_string: oldS, new_string: newS }, tool_response: 'ok', duration_ms: 5, cwd: '/repo' });

test('a two-turn session projects prompts, steps, and file changes end to end', () => {
  const store = tempStore();
  try {
    // Turn 1: "add a retry helper" → edit util.ts
    ingest(store, prompt('turn-1', 'add a retry helper'));
    ingest(store, editPre('turn-1', 'tu-1', '/repo/util.ts', 'const retries = 1', 'const retries = 5'));
    ingest(store, editPost('turn-1', 'tu-1', '/repo/util.ts', 'const retries = 1', 'const retries = 5'));
    // Turn 2: "bump the timeout" → edit config.ts
    ingest(store, prompt('turn-2', 'bump the timeout'));
    ingest(store, editPre('turn-2', 'tu-2', '/repo/config.ts', 'timeout: 3000', 'timeout: 8000'));
    ingest(store, editPost('turn-2', 'tu-2', '/repo/config.ts', 'timeout: 3000', 'timeout: 8000'));

    const s = sessionStory(store, SID);
    assert.equal(s.turns.length, 2);
    assert.equal(s.turns[0].prompt, 'add a retry helper');
    assert.equal(s.turns[1].prompt, 'bump the timeout');

    // each turn changed exactly its one file, with a real diffstat
    assert.deepEqual(s.turns[0].files_changed.map((f) => f.path), ['/repo/util.ts']);
    assert.equal(s.turns[0].files_changed[0].insertions, 1);
    assert.equal(s.turns[0].files_changed[0].deletions, 1);
    assert.deepEqual(s.turns[1].files_changed.map((f) => f.path), ['/repo/config.ts']);

    // session rollup + counts
    assert.deepEqual(s.files_changed.map((f) => f.path).sort(), ['/repo/config.ts', '/repo/util.ts']);
    assert.equal(s.counts.turns, 2);
    assert.equal(s.counts.files, 2);

    // the story is pure interpretation — the chain still verifies
    assert.ok(verify(store).ok);
  } finally {
    store.cleanup();
  }
});

test('a secret pasted into a prompt never reaches the story', () => {
  const store = tempStore();
  try {
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    ingest(store, prompt('turn-1', 'use this key ' + key + ' to call the api'));
    ingest(store, editPre('turn-1', 'tu-1', '/repo/api.ts', 'x', 'y'));
    ingest(store, editPost('turn-1', 'tu-1', '/repo/api.ts', 'x', 'y'));

    const s = sessionStory(store, SID);
    assert.ok(s.turns[0].prompt.includes('[REDACTED'), 'expected a redaction marker');
    assert.ok(!s.turns[0].prompt.includes(key), 'the secret leaked into the story');
  } finally {
    store.cleanup();
  }
});
