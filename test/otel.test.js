'use strict';
// R8 (AARM) — OTLP export. Guards the properties a SIEM and a third-party auditor
// depend on: valid + DETERMINISTIC ids, a correct span tree, honest timings, and
// (the security bar) no blob content or `raw` payload in the exported bytes.
const test = require('node:test');
const assert = require('node:assert');
const { toOtlp } = require('../dist/otel.js');
const { normEv, tempStore } = require('./util.js');

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';

/** A session with one prompt turn and one Pre/Post file_edit pair. */
function seed(store, sid = 'S') {
  store.append(normEv({ session_id: sid, phase: 'session_start', hook_event: 'SessionStart', action_type: 'session', prompt_id: null, ts: T0 }));
  store.append(normEv({ session_id: sid, phase: 'prompt', hook_event: 'UserPromptSubmit', action_type: 'session', ts: T0 }));
  store.append(normEv({ session_id: sid, phase: 'pre', hook_event: 'PreToolUse', tool_use_id: 'tu1', tool_name: 'Edit', action_type: 'file_edit', target: '/repo/a.ts', ts: T0 }));
  store.append(normEv({ session_id: sid, phase: 'post', hook_event: 'PostToolUse', tool_use_id: 'tu1', tool_name: 'Edit', action_type: 'file_edit', target: '/repo/a.ts', duration_ms: 250, ts: T1 }));
  store.append(normEv({ session_id: sid, phase: 'session_end', hook_event: 'SessionEnd', action_type: 'session', prompt_id: null, ts: T1 }));
}

function spansOf(payload) {
  return payload.resourceSpans[0].scopeSpans[0].spans;
}

function attrOf(span, key) {
  const a = span.attributes.find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value;
  return v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue ?? v.arrayValue;
}

test('otel: ids are valid hex, non-zero, and deterministic across runs', () => {
  const store = tempStore();
  try {
    seed(store);
    const a = spansOf(toOtlp(store, ['S']));
    const b = spansOf(toOtlp(store, ['S']));
    assert.ok(a.length >= 3, 'expected root + turn + action spans');
    assert.deepEqual(a, b, 're-export must be byte-identical — random ids would break corroboration');
    for (const s of a) {
      assert.match(s.traceId, /^[0-9a-f]{32}$/, 'traceId must be 16 bytes of hex');
      assert.match(s.spanId, /^[0-9a-f]{16}$/, 'spanId must be 8 bytes of hex');
      assert.ok(!/^0+$/.test(s.traceId) && !/^0+$/.test(s.spanId), 'all-zero ids are invalid per the OTLP spec');
    }
  } finally {
    store.cleanup();
  }
});

test('otel: span tree is session → turn → action, and every parent exists', () => {
  const store = tempStore();
  try {
    seed(store);
    const spans = spansOf(toOtlp(store, ['S']));
    const root = spans.find((s) => s.name === 'session');
    const turn = spans.find((s) => s.name === 'turn');
    const action = spans.find((s) => s.name.startsWith('execute_tool'));
    assert.ok(root && turn && action, 'expected one span at each level');
    assert.equal(root.parentSpanId, undefined, 'the session span is the trace root');
    assert.equal(turn.parentSpanId, root.spanId);
    assert.equal(action.parentSpanId, turn.spanId);
    const ids = new Set(spans.map((s) => s.spanId));
    for (const s of spans) if (s.parentSpanId) assert.ok(ids.has(s.parentSpanId), `orphan span ${s.name}`);
    assert.equal(new Set(spans.map((s) => s.traceId)).size, 1, 'one session is one trace');
  } finally {
    store.cleanup();
  }
});

test('otel: action span carries its verifiable chain position', () => {
  const store = tempStore();
  try {
    seed(store);
    const action = spansOf(toOtlp(store, ['S'])).find((s) => s.name.startsWith('execute_tool'));
    const seq = Number(attrOf(action, 'blackbox.seq'));
    assert.equal(attrOf(action, 'blackbox.event.hash'), store.get(seq).hash, 'the export must point back at the real chain hash');
    assert.equal(attrOf(action, 'gen_ai.tool.name'), 'Edit');
  } finally {
    store.cleanup();
  }
});

test('otel: nanosecond timestamps keep full precision and never end before they start', () => {
  const store = tempStore();
  try {
    seed(store);
    for (const s of spansOf(toOtlp(store, ['S']))) {
      assert.match(s.startTimeUnixNano, /^\d+$/);
      // Number arithmetic silently rounds at this magnitude — the value must be exact.
      assert.equal(s.startTimeUnixNano.length, 19, 'epoch-ns must not be truncated to a float');
      assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano), `${s.name} ends before it starts`);
    }
    const action = spansOf(toOtlp(store, ['S'])).find((s) => s.name.startsWith('execute_tool'));
    const dur = BigInt(action.endTimeUnixNano) - BigInt(action.startTimeUnixNano);
    assert.equal(dur, 250n * 1_000_000n, 'duration_ms must drive the span length');
  } finally {
    store.cleanup();
  }
});

test('otel: a failed tool call sets ERROR status', () => {
  const store = tempStore();
  try {
    store.append(normEv({ phase: 'pre', hook_event: 'PreToolUse', tool_use_id: 'tu1', tool_name: 'Bash', action_type: 'shell_command', target: 'false', ts: T0 }));
    store.append(normEv({ phase: 'failure', hook_event: 'PostToolUseFailure', tool_use_id: 'tu1', tool_name: 'Bash', action_type: 'shell_command', target: 'false', success: 0, ts: T1 }));
    const action = spansOf(toOtlp(store, ['S'])).find((s) => s.name.startsWith('execute_tool'));
    assert.equal(action.status.code, 2, 'ERROR');
  } finally {
    store.cleanup();
  }
});

test('otel: exports only redacted projections — never blob content or raw', () => {
  const store = tempStore();
  try {
    const secret = 'BLOB-CONTENT-MUST-NOT-ESCAPE';
    store.append(
      normEv({ phase: 'pre', hook_event: 'PreToolUse', tool_use_id: 'tu1', tool_name: 'Write', action_type: 'file_write', target: '/repo/a.ts', ts: T0, raw: JSON.stringify({ body: secret }) }),
      { content: secret, encoding: 'utf8' },
    );
    const json = JSON.stringify(toOtlp(store, ['S']));
    assert.equal(json.includes(secret), false, 'blob/raw bytes must never reach the exported telemetry');
  } finally {
    store.cleanup();
  }
});

test('otel: lifecycle events do not become action spans', () => {
  const store = tempStore();
  try {
    seed(store);
    store.append(normEv({ phase: 'reasoning', hook_event: 'ReasoningCapture', action_type: 'session', tool_use_id: null, detail: JSON.stringify({ reasoning: 'x' }), ts: T1 }));
    const spans = spansOf(toOtlp(store, ['S']));
    // Exactly one span may be named "session" — the trace root. session_start /
    // prompt / reasoning / session_end must never appear as nested spans.
    assert.equal(spans.filter((s) => s.name === 'session').length, 1, 'lifecycle rows leaked in as action spans');
    assert.equal(spans.find((s) => s.name === 'session').parentSpanId, undefined);
    assert.deepEqual(spans.map((s) => s.name).sort(), ['execute_tool Edit', 'session', 'turn']);
  } finally {
    store.cleanup();
  }
});

test('otel: unknown session yields an empty payload rather than throwing', () => {
  const store = tempStore();
  try {
    assert.deepEqual(spansOf(toOtlp(store, ['nope'])), []);
  } finally {
    store.cleanup();
  }
});
