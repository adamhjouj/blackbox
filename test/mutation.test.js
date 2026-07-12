'use strict';
// Mutation capture: patches for edits, bodies for writes, content-addressed and
// REDACTED before persistence. Tests require compiled dist/ — run `npm run build`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureMutation } = require('../dist/mutation.js');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { eventDetail } = require('../dist/read-api.js');
const { tempStore } = require('./util.js');

const NUL = String.fromCharCode(0);
let TU = 0;

function editPayload(file_path, old_string, new_string, extra = {}) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path, old_string, new_string },
    session_id: 'S',
    tool_use_id: 'tu' + ++TU,
    cwd: '/repo',
    ...extra,
  };
}
function writePayload(file_path, content, extra = {}) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path, content },
    session_id: 'S',
    tool_use_id: 'tu' + ++TU,
    cwd: '/repo',
    ...extra,
  };
}
const cap = (payload) => normalizeAndCapture(payload, '2026-02-01T00:00:00.000Z');
const factOf = (payload) => JSON.parse(cap(payload).event.detail).mutation;

// ---- kind + shape --------------------------------------------------------
test('file_edit captures a PATCH, not two bodies', () => {
  const { event, blob } = cap(editPayload('/repo/a.ts', 'const x = 1;', 'const x = 2;'));
  const m = JSON.parse(event.detail).mutation;
  assert.equal(m.kind, 'patch');
  assert.ok(blob && blob.content.includes('-const x = 1;'));
  assert.ok(blob.content.includes('+const x = 2;'));
  assert.equal(blob.content_hash, m.content_hash);
});

test('file_write captures the full body', () => {
  const { event, blob } = cap(writePayload('/repo/new.ts', 'line1\nline2\n'));
  const m = JSON.parse(event.detail).mutation;
  assert.equal(m.kind, 'body');
  assert.equal(blob.content, 'line1\nline2\n');
});

test('non-file actions capture nothing', () => {
  assert.equal(captureMutation('shell_command', { command: 'ls' }), null);
  assert.equal(captureMutation('file_read', { file_path: '/a' }), null);
  const { blob, event } = cap({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a' }, session_id: 'S' });
  assert.equal(blob, null);
  assert.ok(!event.detail || JSON.parse(event.detail).mutation === undefined);
});

// ---- diffstat accuracy (LCS, not remove-all/add-all) ---------------------
test('diffstat counts only the changed lines', () => {
  const m = factOf(editPayload('/repo/a.ts', 'a\nb\nc\nd\ne', 'a\nb\nX\nd\ne'));
  assert.deepEqual(m.diffstat, { files: 1, insertions: 1, deletions: 1 });
});

test('created content (empty old_string) is pure insertion', () => {
  const m = factOf(editPayload('/repo/a.ts', '', 'l1\nl2'));
  assert.equal(m.diffstat.deletions, 0);
  assert.equal(m.diffstat.insertions, 2);
});

test('deleted content (empty new_string) is pure deletion', () => {
  const m = factOf(editPayload('/repo/a.ts', 'l1\nl2', ''));
  assert.equal(m.diffstat.insertions, 0);
  assert.equal(m.diffstat.deletions, 2);
});

// ---- REDACTION before persistence (requirement 3) ------------------------
const noLeak = (blob, secret) => {
  assert.ok(blob && blob.content.includes('[REDACTED'), 'expected a [REDACTED marker');
  assert.ok(!blob.content.includes(secret), 'secret leaked into stored content');
};

test('an API key added in a patch hunk is redacted in the stored patch', () => {
  const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const { blob, event } = cap(editPayload('/repo/cfg.ts', 'const k = "";', 'const k = "' + key + '";'));
  noLeak(blob, key);
  assert.equal(JSON.parse(event.detail).mutation.redacted, true);
});

test('a PEM private key in a written body is redacted', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAA\n-----END PRIVATE KEY-----';
  const { blob } = cap(writePayload('/repo/deploy.ts', 'const cert = `' + pem + '`;'));
  noLeak(blob, 'MIIBVgIBADANBgkqhkiG9w0BAQEFAA');
});

test('a .env-style secret in a patch is redacted', () => {
  const { blob } = cap(editPayload('/repo/setup.sh', 'echo hi', 'DB_PASSWORD=hunter2secret'));
  noLeak(blob, 'hunter2secret');
});

test('the redactText gate scrubs secrets even if upstream is bypassed', () => {
  // captureMutation is called directly on RAW (un-pre-redacted) input — the final
  // gate must still catch the secret so nothing unredacted is ever content-addressed.
  const key = 'sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210';
  const c = captureMutation('file_write', { content: 'const k = "' + key + '";' });
  noLeak(c.blob, key);
});

// ---- sensitive-path files (content dropped upstream, still recorded) ------
test('a .env write records the mutation without leaking content', () => {
  const { blob, event } = cap(writePayload('/repo/.env', 'API_KEY=supersecretvalue123'));
  const m = JSON.parse(event.detail).mutation;
  assert.equal(m.kind, 'body');
  assert.ok(!blob || !blob.content.includes('supersecretvalue123'));
});

// ---- bounds --------------------------------------------------------------
test('content over ~1MB is skipped (commitment kept, no bytes stored)', () => {
  const big = 'x'.repeat(1024 * 1024 + 10);
  const { blob, event } = cap(writePayload('/repo/big.txt', big));
  const m = JSON.parse(event.detail).mutation;
  assert.equal(m.stored, false);
  assert.equal(m.skip_reason, 'oversize');
  assert.ok(m.content_hash && m.bytes > 1024 * 1024);
  assert.equal(blob, null);
});

test('binary content (NUL byte) is skipped', () => {
  const { blob, event } = cap(writePayload('/repo/bin', 'a' + NUL + 'b'));
  const m = JSON.parse(event.detail).mutation;
  assert.equal(m.stored, false);
  assert.equal(m.skip_reason, 'binary');
  assert.equal(blob, null);
});

// ---- storage discipline: 40 edits → 40 small patches, not 80 copies ------
test('40 edits to a large file store 40 small patches', () => {
  const store = tempStore();
  try {
    const big = Array.from({ length: 500 }, (_, i) => 'line ' + i).join('\n');
    let stored = 0;
    let maxBlob = 0;
    for (let i = 0; i < 40; i++) {
      const oldS = 'line ' + i;
      const newS = 'line ' + i + ' // edited';
      const { event, blob } = cap(editPayload('/repo/big.ts', oldS, newS));
      store.append(event, blob);
      if (blob) {
        stored++;
        maxBlob = Math.max(maxBlob, blob.bytes);
      }
    }
    assert.equal(stored, 40);
    assert.equal(store.blobLiveCount(), 40);
    // Each patch is the tiny changed snippet, never the ~5KB whole file.
    assert.ok(maxBlob < 200, 'a patch blob was unexpectedly large: ' + maxBlob);
    assert.ok(big.length > 40 * maxBlob, 'patches should be far smaller than the file');
  } finally {
    store.cleanup();
  }
});

test('identical write bodies are content-addressed (stored once)', () => {
  const store = tempStore();
  try {
    const a = cap(writePayload('/repo/x.ts', 'same body\n'));
    const b = cap(writePayload('/repo/y.ts', 'same body\n'));
    store.append(a.event, a.blob);
    store.append(b.event, b.blob);
    assert.equal(a.blob.content_hash, b.blob.content_hash);
    assert.equal(store.blobCount(), 1);
  } finally {
    store.cleanup();
  }
});

// ---- end-to-end: the dossier reconstructs the diff from the stored patch --
test('eventDetail reconstructs the before/after diff from the stored patch', () => {
  const store = tempStore();
  try {
    const { event, blob } = cap(editPayload('/repo/a.ts', 'old line', 'new line'));
    const stored = store.append(event, blob);
    const d = eventDetail(store, stored.seq);
    assert.equal(d.mutation.status, 'available');
    assert.equal(d.mutation.kind, 'patch');
    assert.ok(d.mutation.content.includes('-old line'));
    assert.ok(d.mutation.content.includes('+new line'));
    assert.deepEqual(d.mutation.diffstat, { files: 1, insertions: 1, deletions: 1 });
  } finally {
    store.cleanup();
  }
});

test('a skipped (oversize) mutation shows a skipped status, no content', () => {
  const store = tempStore();
  try {
    const { event, blob } = cap(writePayload('/repo/big.txt', 'x'.repeat(1024 * 1024 + 10)));
    const stored = store.append(event, blob);
    const d = eventDetail(store, stored.seq);
    assert.equal(d.mutation.status, 'skipped');
    assert.equal(d.mutation.skip_reason, 'oversize');
    assert.equal(d.mutation.content, null);
  } finally {
    store.cleanup();
  }
});
