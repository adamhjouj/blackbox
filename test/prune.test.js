'use strict';
// Retention: prune drops mutation CONTENT while keeping the events, their hashes,
// and a queryable tombstone — so `verify` is byte-identical before and after.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { eventDetail } = require('../dist/read-api.js');
const { verify } = require('../dist/verify.js');
const { tempStore } = require('./util.js');

const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-03-01T00:00:00.000Z';
const CUT = '2026-02-01T00:00:00.000Z';
const PRUNED_AT = '2026-03-02T00:00:00.000Z';
let TU = 0;

function appendEdit(store, { file = '/repo/a.ts', oldS, newS, ts, session = 'S' }) {
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: oldS, new_string: newS },
    session_id: session,
    tool_use_id: 'tu' + ++TU,
    cwd: '/repo',
    _captured_at: ts,
  };
  const { event, blob } = normalizeAndCapture(payload, ts);
  return { stored: store.append(event, blob), blob };
}

function appendShell(store, { cmd = 'ls -la', ts }) {
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: cmd },
    session_id: 'S',
    tool_use_id: 'tu' + ++TU,
    cwd: '/repo',
    _captured_at: ts,
  };
  const { event, blob } = normalizeAndCapture(payload, ts);
  return store.append(event, blob);
}

test('prune drops old content, keeps recent content, and verify stays byte-identical', () => {
  const store = tempStore();
  try {
    const a = appendEdit(store, { file: '/repo/a.ts', oldS: 'a1', newS: 'a2', ts: OLD });
    const b = appendEdit(store, { file: '/repo/b.ts', oldS: 'b1', newS: 'b2', ts: NEW });

    const before = verify(store);
    assert.ok(before.ok);
    const headBefore = store.chainMeta().head_hash;

    const r = store.prune(CUT, PRUNED_AT);
    assert.equal(r.pruned, 1);
    assert.ok(r.bytesFreed > 0);

    // Old blob → tombstone (content gone, commitment kept); recent blob → intact.
    const oldBlob = store.blobGet(a.blob.content_hash);
    assert.equal(oldBlob.content, null);
    assert.equal(oldBlob.pruned_at, PRUNED_AT);
    assert.equal(store.blobGet(b.blob.content_hash).content, b.blob.content);

    // Tombstones are kept as rows; only content is dropped.
    assert.equal(store.blobCount(), 2);
    assert.equal(store.blobLiveCount(), 1);

    // The chain is untouched: same count, same head hash, verify still green.
    const after = verify(store);
    assert.ok(after.ok);
    assert.equal(after.count, before.count);
    assert.equal(store.chainMeta().head_hash, headBefore);
  } finally {
    store.cleanup();
  }
});

test('a blob shared by a still-recent event is NOT pruned (content-addressed dedupe)', () => {
  const store = tempStore();
  try {
    // Same old→new snippet at an old AND a recent time → one shared content hash.
    const a = appendEdit(store, { file: '/repo/x.ts', oldS: 'shared-old', newS: 'shared-new', ts: OLD });
    const c = appendEdit(store, { file: '/repo/y.ts', oldS: 'shared-old', newS: 'shared-new', ts: NEW });
    assert.equal(a.blob.content_hash, c.blob.content_hash);
    assert.equal(store.blobCount(), 1);

    const r = store.prune(CUT, PRUNED_AT);
    assert.equal(r.pruned, 0);
    assert.equal(store.blobGet(a.blob.content_hash).content, a.blob.content);
  } finally {
    store.cleanup();
  }
});

test('a pruned mutation reads as a tombstone in the dossier (record retained)', () => {
  const store = tempStore();
  try {
    const a = appendEdit(store, { oldS: 'o', newS: 'n', ts: OLD });
    store.prune(CUT, PRUNED_AT);
    const d = eventDetail(store, a.stored.seq);
    assert.equal(d.mutation.status, 'pruned');
    assert.equal(d.mutation.content, null);
    assert.equal(d.mutation.pruned_at, PRUNED_AT);
    assert.deepEqual(d.mutation.diffstat, { files: 1, insertions: 1, deletions: 1 });
  } finally {
    store.cleanup();
  }
});

test('pruning an empty/never-mutated store is a no-op and verify passes', () => {
  const store = tempStore();
  try {
    appendShell(store, { ts: OLD });
    const r = store.prune(CUT, PRUNED_AT);
    assert.equal(r.pruned, 0);
    assert.ok(verify(store).ok);
  } finally {
    store.cleanup();
  }
});

test('capturing mutations is hash-neutral to earlier events (append-only)', () => {
  const store = tempStore();
  try {
    const first = appendShell(store, { cmd: 'echo hi', ts: OLD });
    const h1 = store.get(first.seq).hash;
    // A shell event carries no mutation fact — the OUT-of-scope path is untouched.
    const fdetail = store.get(first.seq).detail;
    assert.ok(!fdetail || JSON.parse(fdetail).mutation === undefined);

    appendEdit(store, { oldS: 'p', newS: 'q', ts: NEW });
    appendEdit(store, { oldS: 'r', newS: 's', ts: NEW });

    assert.equal(store.get(first.seq).hash, h1);
    assert.ok(verify(store).ok);
  } finally {
    store.cleanup();
  }
});
