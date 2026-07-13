'use strict';
// R8.2 corpus search: a re-derivable FTS5 index over redacted event text (targets,
// action summaries, prompts, reasoning, commit subjects) — never blob content.
// Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { indexNew, reindexAll, search } = require('../dist/search.js');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { tempStore } = require('./util.js');

const AT = '2026-02-01T00:00:00.000Z';
let TU = 0;
function pre(store, cmd) {
  const { event } = normalizeAndCapture({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 'S', tool_use_id: 'c' + ++TU, cwd: '/repo' }, AT);
  return store.append(event);
}
function pair(store, cmd) {
  // a Pre AND its Post (same tool_use_id) — search must return only ONE hit
  const tu = 'p' + ++TU;
  const { event: preE } = normalizeAndCapture({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 'S', tool_use_id: tu, cwd: '/repo' }, AT);
  store.append(preE);
  const { event: postE } = normalizeAndCapture({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 'S', tool_use_id: tu, cwd: '/repo' }, AT);
  store.append(postE);
}
function prompt(store, text) {
  const { event } = normalizeAndCapture({ hook_event_name: 'UserPromptSubmit', session_id: 'S', prompt_id: 'P' + ++TU, cwd: '/repo', prompt: text }, AT);
  return store.append(event);
}

test('indexNew indexes events and search finds them by term with a snippet', () => {
  const store = tempStore();
  try {
    const e = pre(store, 'grep authenticate src/login.ts');
    const added = indexNew(store);
    assert.ok(added >= 1);
    const { hits } = search(store, 'authenticate');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].seq, e.seq);
    assert.ok(hits[0].snippet.includes('[authenticate]'), 'snippet highlights the match');
  } finally {
    store.cleanup();
  }
});

test('a Pre/Post tool pair is indexed ONCE (deduped to the Pre)', () => {
  const store = tempStore();
  try {
    pair(store, 'chmod 777 uniquetoken_xyz');
    indexNew(store);
    const { hits } = search(store, 'uniquetoken_xyz');
    assert.equal(hits.length, 1, 'the command should match a single row, not both Pre and Post');
  } finally {
    store.cleanup();
  }
});

test('prompts are searchable', () => {
  const store = tempStore();
  try {
    prompt(store, 'please refactor the payment reconciliation module');
    indexNew(store);
    const { hits } = search(store, 'reconciliation');
    const hit = hits.find((h) => h.kind === 'prompt');
    assert.ok(hit);
    assert.match(hit.prompt_id, /^P\d+$/, 'search hits carry the turn join key for deep navigation');
  } finally {
    store.cleanup();
  }
});

test('indexNew is incremental (a second pass indexes only new events)', () => {
  const store = tempStore();
  try {
    pre(store, 'echo one');
    assert.ok(indexNew(store) >= 1);
    assert.equal(indexNew(store), 0, 'nothing new to index');
    pre(store, 'echo two');
    assert.equal(indexNew(store), 1, 'only the new event');
  } finally {
    store.cleanup();
  }
});

test('reindexAll rebuilds from scratch', () => {
  const store = tempStore();
  try {
    pre(store, 'echo alpha');
    indexNew(store);
    const n = reindexAll(store);
    assert.ok(n >= 1);
    assert.ok(search(store, 'alpha').hits.length >= 1);
  } finally {
    store.cleanup();
  }
});

test('a malformed FTS query degrades instead of throwing', () => {
  const store = tempStore();
  try {
    pre(store, 'echo hello');
    indexNew(store);
    assert.doesNotThrow(() => search(store, 'hello AND ('));
    assert.doesNotThrow(() => search(store, '"unterminated'));
    assert.deepEqual(search(store, '').hits, []);
  } finally {
    store.cleanup();
  }
});

test('a secret in a command is NOT searchable (indexed text is redacted at capture)', () => {
  const store = tempStore();
  try {
    pre(store, 'curl -H "Authorization: Bearer sk-ant-supersecret000111222333" https://api.x');
    indexNew(store);
    assert.equal(search(store, 'supersecret000111222333').hits.length, 0, 'the secret was redacted before indexing');
  } finally {
    store.cleanup();
  }
});
