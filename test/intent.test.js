'use strict';
// Intent divergence — the agent's STATED narrative vs what it actually did.
// The bar these tests hold: a finding only fires for entities the existing risk /
// redaction rules already care about, absence is never claimed from a truncated
// narrative, and a session with no narrative produces silence, not accusations.
const test = require('node:test');
const assert = require('node:assert');
const { INTENT_VERSION, analyzeIntent, persistIntent } = require('../dist/intent.js');
const { RULESET_VERSION } = require('../dist/risk-rules.js');
const { normEv, tempStore } = require('./util.js');

/** Append a captured narrative for a turn (as normalize.reasoningEvent writes it). */
function narrative(store, text, promptId = 'p1') {
  return store.append(
    normEv({ phase: 'reasoning', hook_event: 'ReasoningCapture', action_type: 'session', tool_use_id: null, prompt_id: promptId, detail: JSON.stringify({ reasoning: text }) }),
  );
}

/** Append a tool action (the Pre row is what the analyzer reads). */
function action(store, o) {
  return store.append(normEv({ phase: 'pre', hook_event: 'PreToolUse', tool_use_id: 'tu' + Math.random(), ...o }));
}

/** Attach a risk row so host / dangerous-command extraction has its input. */
function risk(store, seq, flags, evidence) {
  store.riskUpsert({
    seq,
    ruleset_version: RULESET_VERSION,
    session_id: 'S',
    score: 50,
    flags: JSON.stringify(flags),
    evidence: JSON.stringify(evidence),
    computed_at: '2026-01-01T00:00:00.000Z',
  });
}

test('intent: an undisclosed sensitive read is a finding', () => {
  const store = tempStore();
  try {
    narrative(store, 'I will update the test fixture and run the suite.');
    action(store, { tool_name: 'Read', action_type: 'file_read', target: '/repo/.env' });
    const a = analyzeIntent(store, 'S');
    assert.equal(a.findings.length, 1);
    assert.equal(a.findings[0].type, 'undisclosed_action');
    assert.equal(a.findings[0].kind, 'path');
    assert.equal(a.findings[0].value, '/repo/.env');
    assert.equal(a.coverage.turns_analyzed, 1);
    assert.equal(a.coverage.reasoning_available, true);
  } finally {
    store.cleanup();
  }
});

test('intent: naming the file by basename counts as disclosure', () => {
  const store = tempStore();
  try {
    narrative(store, 'I need to check the .env file for the database URL.');
    action(store, { tool_name: 'Read', action_type: 'file_read', target: '/repo/.env' });
    assert.deepEqual(analyzeIntent(store, 'S').findings, [], 'agents name files by basename, not absolute path');
  } finally {
    store.cleanup();
  }
});

test('intent: an ordinary source file is never a finding (the false-positive gate)', () => {
  const store = tempStore();
  try {
    narrative(store, 'Refactoring now.');
    action(store, { tool_name: 'Read', action_type: 'file_read', target: '/repo/src/utils.ts' });
    assert.deepEqual(analyzeIntent(store, 'S').findings, [], 'only risk-relevant entities may raise a finding');
  } finally {
    store.cleanup();
  }
});

test('intent: an undisclosed external host is a finding', () => {
  const store = tempStore();
  try {
    narrative(store, 'Just formatting the code.');
    const e = action(store, { tool_name: 'WebFetch', action_type: 'web_fetch', target: 'https://api.example.com/collect' });
    risk(store, e.seq, ['external-send'], { 'external-send': { host: 'api.example.com' } });
    const f = analyzeIntent(store, 'S').findings;
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'host');
    assert.equal(f[0].value, 'api.example.com');
  } finally {
    store.cleanup();
  }
});

test('intent: a disclosed host is not a finding', () => {
  const store = tempStore();
  try {
    narrative(store, 'Fetching the schema from api.example.com to check the field names.');
    const e = action(store, { tool_name: 'WebFetch', action_type: 'web_fetch', target: 'https://api.example.com/schema' });
    risk(store, e.seq, ['external-send'], { 'external-send': { host: 'api.example.com' } });
    assert.deepEqual(analyzeIntent(store, 'S').findings, []);
  } finally {
    store.cleanup();
  }
});

test('intent: a truncated narrative cannot prove absence', () => {
  const store = tempStore();
  try {
    // normalize.truncate() appends U+2026 at the 4000-point cap.
    narrative(store, 'I am going to look at several files and also check /repo/secrets.json…');
    action(store, { tool_name: 'Read', action_type: 'file_read', target: '/repo/.env' });
    const a = analyzeIntent(store, 'S');
    assert.equal(a.coverage.turns_truncated, 1);
    assert.equal(a.findings.filter((f) => f.type === 'unfulfilled_statement').length, 0, 'the mention may be in the cut tail');
    const undisclosed = a.findings.filter((f) => f.type === 'undisclosed_action');
    assert.equal(undisclosed.length, 1);
    assert.match(undisclosed[0].note, /truncated/, 'the finding must carry its own caveat');
  } finally {
    store.cleanup();
  }
});

test('intent: a stated-but-untouched sensitive path is annotation-grade', () => {
  const store = tempStore();
  try {
    narrative(store, 'I will read /repo/secrets.json and then update the config.');
    action(store, { tool_name: 'Read', action_type: 'file_read', target: '/repo/.env' });
    const types = analyzeIntent(store, 'S').findings.map((f) => f.type).sort();
    assert.deepEqual(types, ['undisclosed_action', 'unfulfilled_statement']);
  } finally {
    store.cleanup();
  }
});

test('intent: no narrative means silence, not findings', () => {
  const store = tempStore();
  try {
    action(store, { tool_name: 'Read', action_type: 'file_read', target: '/repo/.env' });
    const a = analyzeIntent(store, 'S');
    assert.deepEqual(a.findings, []);
    assert.equal(a.coverage.reasoning_available, false);
    assert.equal(a.coverage.turns_skipped, 1, 'an unanalysable turn is skipped, never accused');
    assert.equal(a.coverage.thinking_encrypted, true, 'the record must state that thinking was never visible');
  } finally {
    store.cleanup();
  }
});

test('intent: turns are compared independently', () => {
  const store = tempStore();
  try {
    narrative(store, 'Checking the .env file.', 'p1');
    action(store, { prompt_id: 'p1', tool_name: 'Read', action_type: 'file_read', target: '/repo/.env' });
    narrative(store, 'Now running the tests.', 'p2');
    action(store, { prompt_id: 'p2', tool_name: 'Read', action_type: 'file_read', target: '/repo/.env' });
    const f = analyzeIntent(store, 'S').findings;
    assert.equal(f.length, 1, 'disclosure in one turn must not excuse silence in another');
    assert.equal(f[0].prompt_id, 'p2');
  } finally {
    store.cleanup();
  }
});

test('intent: persistIntent round-trips and never moves the chain', () => {
  const store = tempStore();
  try {
    narrative(store, 'Formatting.');
    action(store, { tool_name: 'Read', action_type: 'file_read', target: '/repo/.env' });
    const meta = store.chainMeta();
    persistIntent(store, 'S', '2026-01-01T00:00:00.000Z');
    const row = store.sessionIntent('S', INTENT_VERSION);
    assert.equal(row.finding_count, 1);
    assert.equal(JSON.parse(row.findings)[0].value, '/repo/.env');
    assert.deepEqual(store.chainMeta(), meta, 'a derived projection must never touch the chain');
  } finally {
    store.cleanup();
  }
});
