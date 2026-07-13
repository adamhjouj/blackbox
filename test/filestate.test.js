'use strict';
// R7.2 file history: a pure projection of what the agent did to one file, in order,
// from the immutable mutation facts (+ their content-addressed blobs). Zero
// fabrication — every entry is a recorded fact. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { normalizeAndCapture, worktreeDeltaEvent } = require('../dist/normalize.js');
const { fileHistory, reconstructAt } = require('../dist/filestate.js');
const { tempStore, normEv } = require('./util.js');

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

let TU = 0;
function write(store, file, content, session = 'S') {
  const { event, blob } = normalizeAndCapture(
    { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content }, session_id: session, tool_use_id: 'w' + ++TU, cwd: '/repo' },
    '2026-02-01T00:00:0' + (TU % 10) + '.000Z',
  );
  return store.append(event, blob);
}
function edit(store, file, oldS, newS, session = 'S') {
  const { event, blob } = normalizeAndCapture(
    { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: oldS, new_string: newS }, session_id: session, tool_use_id: 'e' + ++TU, cwd: '/repo' },
    '2026-02-01T00:00:0' + (TU % 10) + '.000Z',
  );
  return store.append(event, blob);
}

test('fileHistory lists a file\'s mutations in seq order with kinds + diffstat + content', () => {
  const store = tempStore();
  try {
    write(store, '/repo/auth.ts', 'a\nb\nc\n');
    edit(store, '/repo/auth.ts', 'b', 'B');
    edit(store, '/repo/auth.ts', 'c', 'C');
    const h = fileHistory(store, 'S', '/repo/auth.ts');
    assert.equal(h.mutations.length, 3);
    assert.deepEqual(h.mutations.map((m) => m.kind), ['body', 'patch', 'patch']);
    assert.deepEqual(
      h.mutations.map((m) => m.seq),
      [...h.mutations.map((m) => m.seq)].sort((x, y) => x - y),
    );
    assert.ok(h.mutations[0].content.includes('a'), 'body content stored');
    assert.ok(h.mutations[1].content.includes('+B') && h.mutations[1].content.includes('-b'), 'patch shows old/new');
    assert.equal(h.mutations[1].tool, 'Edit');
  } finally {
    store.cleanup();
  }
});

test('fileHistory matches by path suffix (repo-relative query)', () => {
  const store = tempStore();
  try {
    write(store, '/repo/src/auth.ts', 'x\n');
    const h = fileHistory(store, 'S', 'src/auth.ts');
    assert.equal(h.mutations.length, 1);
  } finally {
    store.cleanup();
  }
});

test('fileHistory isolates one path from another', () => {
  const store = tempStore();
  try {
    write(store, '/repo/a.ts', 'a\n');
    write(store, '/repo/b.ts', 'b\n');
    edit(store, '/repo/b.ts', 'b', 'B');
    assert.equal(fileHistory(store, 'S', '/repo/a.ts').mutations.length, 1);
    assert.equal(fileHistory(store, 'S', '/repo/b.ts').mutations.length, 2);
  } finally {
    store.cleanup();
  }
});

test('a sensitive-path write is marked redacted and never exposes the secret', () => {
  const store = tempStore();
  try {
    write(store, '/repo/.env', 'API_KEY=sk-supersecret-value');
    const h = fileHistory(store, 'S', '/repo/.env');
    assert.equal(h.mutations.length, 1);
    assert.equal(h.mutations[0].redacted, true);
    assert.ok(!(h.mutations[0].content || '').includes('sk-supersecret-value'), 'secret leaked into history');
  } finally {
    store.cleanup();
  }
});

test('fileHistory surfaces the git base and the R2 end-of-session sha256', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'S', phase: 'session_start', hook_event: 'SessionStart', tool_use_id: null, detail: JSON.stringify({ anchor: { head_sha: 'deadbeefcafe', branch: 'main' } }) }));
    write(store, '/repo/auth.ts', 'a\n');
    const delta = { base: 'deadbeefcafe', head: 'deadbeefcafe', files: [{ path: 'auth.ts', status: 'M', insertions: 1, deletions: 0, sha256: 'sha256:' + 'f'.repeat(64) }], truncated: false, hash_truncated: false };
    store.append(worktreeDeltaEvent('S', delta, '2026-02-01T00:00:09.000Z'));
    const h = fileHistory(store, 'S', 'auth.ts');
    assert.equal(h.base_sha, 'deadbeefcafe');
    assert.equal(h.end_sha256, 'sha256:' + 'f'.repeat(64));
  } finally {
    store.cleanup();
  }
});

test('an empty history is returned for an untouched path (no crash)', () => {
  const store = tempStore();
  try {
    write(store, '/repo/a.ts', 'a\n');
    const h = fileHistory(store, 'S', '/repo/never.ts');
    assert.equal(h.mutations.length, 0);
  } finally {
    store.cleanup();
  }
});

// ── reconstructAt (R7.2b) ────────────────────────────────────────────────────
test('reconstructAt replays write→edit→edit to the exact bytes', () => {
  const store = tempStore();
  try {
    const w = write(store, '/repo/f.ts', 'a\nb\nc\n');
    const e1 = edit(store, '/repo/f.ts', 'b', 'B');
    const e2 = edit(store, '/repo/f.ts', 'c', 'C');
    // at the write: exact snapshot
    assert.deepEqual(reconstructAt(store, 'S', '/repo/f.ts', w.seq), { path: '/repo/f.ts', seq: w.seq, content: 'a\nb\nc\n', confidence: 'exact' });
    // after the first edit (unverified — no end hash): replayed
    const mid = reconstructAt(store, 'S', '/repo/f.ts', e1.seq);
    assert.equal(mid.content, 'a\nB\nc\n');
    assert.equal(mid.confidence, 'replayed');
    // after both edits
    assert.equal(reconstructAt(store, 'S', '/repo/f.ts', e2.seq).content, 'a\nB\nC\n');
  } finally {
    store.cleanup();
  }
});

test('reconstructAt is verified EXACT when it matches the end-of-session on-disk hash', () => {
  const store = tempStore();
  try {
    write(store, '/repo/f.ts', 'a\nb\n');
    const last = edit(store, '/repo/f.ts', 'b', 'B'); // final content "a\nB\n"
    const delta = { base: 'x', head: 'x', files: [{ path: 'f.ts', status: 'M', insertions: 1, deletions: 1, sha256: sha256('a\nB\n') }], truncated: false, hash_truncated: false };
    store.append(worktreeDeltaEvent('S', delta, '2026-02-01T00:00:09.000Z'));
    const r = reconstructAt(store, 'S', '/repo/f.ts', last.seq);
    assert.equal(r.content, 'a\nB\n');
    assert.equal(r.confidence, 'exact', 'end-hash match should upgrade to exact');
  } finally {
    store.cleanup();
  }
});

test('reconstructAt flags a GHOST write when the end hash disagrees', () => {
  const store = tempStore();
  try {
    write(store, '/repo/f.ts', 'a\nb\n');
    const last = edit(store, '/repo/f.ts', 'b', 'B');
    // the on-disk end state is NOT what our replay produces (an unrecorded write happened)
    const delta = { base: 'x', head: 'x', files: [{ path: 'f.ts', status: 'M', insertions: 9, deletions: 9, sha256: sha256('TOTALLY DIFFERENT\n') }], truncated: false, hash_truncated: false };
    store.append(worktreeDeltaEvent('S', delta, '2026-02-01T00:00:09.000Z'));
    const r = reconstructAt(store, 'S', '/repo/f.ts', last.seq);
    assert.equal(r.confidence, 'partial');
    assert.match(r.divergence.reason, /does not match the end-of-session on-disk hash/);
  } finally {
    store.cleanup();
  }
});

test('reconstructAt STOPS (never fabricates) when an edit diverges from the base', () => {
  const store = tempStore();
  try {
    write(store, '/repo/f.ts', 'a\nb\n');
    edit(store, '/repo/f.ts', 'b', 'B'); // content now "a\nB\n"
    const bad = edit(store, '/repo/f.ts', 'zzz', 'ZZZ'); // "zzz" is not present → divergence
    const r = reconstructAt(store, 'S', '/repo/f.ts', bad.seq);
    assert.equal(r.confidence, 'partial');
    assert.equal(r.divergence.seq, bad.seq);
    assert.equal(r.content, 'a\nB\n', 'content is the last GOOD state, not a fabricated one');
  } finally {
    store.cleanup();
  }
});

test('reconstructAt is unavailable when the first in-session touch is an edit (needs git base)', () => {
  const store = tempStore();
  try {
    const e = edit(store, '/repo/pre-existing.ts', 'old', 'new'); // no prior Write snapshot
    const r = reconstructAt(store, 'S', '/repo/pre-existing.ts', e.seq);
    assert.equal(r.confidence, 'unavailable');
    assert.match(r.divergence.reason, /no in-session snapshot/);
  } finally {
    store.cleanup();
  }
});
