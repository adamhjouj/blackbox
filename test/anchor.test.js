'use strict';
// R6 external anchoring: a signed head RECEIPT placed off-machine (file / git / URL)
// that a ~/.blackbox writer can't reach. Any surviving receipt that no longer
// matches the chain PROVES a rewrite — the attack R3's local key+watermark can't
// resist. Receipts reuse the R3 checkpoint signature (no new crypto). Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { mkdtempSync, rmSync, existsSync, execSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { verify } = require('../dist/verify.js');
const { signCheckpoint } = require('../dist/sign.js');
const { parseAnchorTarget, keyFingerprint, receiptFromSignature, emitReceipt, readReceipts, ANCHOR_REF } = require('../dist/anchor.js');
const { tempStore } = require('./util.js');

const TS = '2026-02-01T00:00:00.000Z';
function kp() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}
function seed(store, n = 3) {
  for (let i = 0; i < n; i++) {
    const { event, blob } = normalizeAndCapture(
      { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/a' + i + '.ts', old_string: 'x', new_string: 'y' }, session_id: 'S', tool_use_id: 'tu' + i, cwd: '/r' },
      '2026-02-01T00:00:0' + i + '.000Z',
    );
    store.append(event, blob);
  }
}
// An authentic receipt for (seq, headHash) signed with `keys` — as an honest anchor
// would have recorded it at the time.
function receipt(keys, seq, headHash, ts = TS) {
  return { v: 1, seq, head_hash: headHash, sig: signCheckpoint(seq, headHash, ts, keys.privateKeyPem), pubkey_fp: keyFingerprint(keys.publicKeyPem), signed_at: ts };
}

// ---- target parsing --------------------------------------------------------
test('parseAnchorTarget recognises file / git / https and rejects junk', () => {
  assert.deepEqual(parseAnchorTarget('file:/tmp/a.jsonl'), { kind: 'file', path: '/tmp/a.jsonl' });
  assert.deepEqual(parseAnchorTarget('git:/repos/anchors'), { kind: 'git', repo: '/repos/anchors' });
  assert.deepEqual(parseAnchorTarget('https://x.io/anchor'), { kind: 'https', url: 'https://x.io/anchor' });
  assert.equal(parseAnchorTarget('nonsense'), null);
  assert.equal(parseAnchorTarget(null), null);
});

// ---- verify(): the matching / mismatch matrix ------------------------------
test('a receipt matching the current head verifies OK', () => {
  const store = tempStore();
  try {
    seed(store, 3);
    const A = kp();
    const head = store.chainMeta().head_hash;
    const v = verify(store, { trustedPublicKey: A.publicKeyPem, anchors: [receipt(A, 3, head)] });
    assert.ok(v.ok, JSON.stringify(v.break));
  } finally {
    store.cleanup();
  }
});

test('a receipt for a DIFFERENT head at a live seq proves a rewrite (anchor-mismatch)', () => {
  const store = tempStore();
  try {
    seed(store, 3);
    const A = kp();
    // the anchor witnessed head "bbb..." at seq 3; the chain now shows something else
    const anchored = 'sha256:' + 'b'.repeat(64);
    const v = verify(store, { trustedPublicKey: A.publicKeyPem, anchors: [receipt(A, 3, anchored)] });
    assert.equal(v.ok, false);
    assert.equal(v.break.reason, 'anchor-mismatch');
    assert.equal(v.break.seq, 3);
    assert.match(v.break.detail, /rewritten/);
  } finally {
    store.cleanup();
  }
});

test('a receipt beyond the chain proves truncation below an anchored head', () => {
  const store = tempStore();
  try {
    seed(store, 3);
    const A = kp();
    const ghost = 'sha256:' + 'c'.repeat(64);
    const v = verify(store, { trustedPublicKey: A.publicKeyPem, anchors: [receipt(A, 8, ghost)] });
    assert.equal(v.ok, false);
    assert.equal(v.break.reason, 'anchor-mismatch');
    assert.equal(v.break.seq, 8);
    assert.match(v.break.detail, /truncated below an anchored head/);
  } finally {
    store.cleanup();
  }
});

test('a receipt signed with the WRONG key is rejected as forged', () => {
  const store = tempStore();
  try {
    seed(store, 3);
    const A = kp();
    const B = kp(); // attacker key
    const head = store.chainMeta().head_hash;
    const v = verify(store, { trustedPublicKey: A.publicKeyPem, anchors: [receipt(B, 3, head)] });
    assert.equal(v.ok, false);
    assert.equal(v.break.reason, 'anchor-mismatch');
    assert.match(v.break.detail, /forged, or the key was rotated/);
  } finally {
    store.cleanup();
  }
});

test('anchors are ignored without a trusted key (nothing to authenticate them)', () => {
  const store = tempStore();
  try {
    seed(store, 3);
    const A = kp();
    const bogus = receipt(A, 3, 'sha256:' + 'd'.repeat(64));
    assert.ok(verify(store, { anchors: [bogus] }).ok, 'no trusted key → anchors skipped');
  } finally {
    store.cleanup();
  }
});

// ---- file provider round-trip ---------------------------------------------
test('file provider: emit → read back → verify OK', async () => {
  const store = tempStore();
  const dir = mkdtempSync(join(tmpdir(), 'bb-anchor-'));
  try {
    seed(store, 3);
    const A = kp();
    const head = store.chainMeta().head_hash;
    const target = { kind: 'file', path: join(dir, 'receipts.jsonl') };
    const r1 = await emitReceipt(target, receipt(A, 3, head));
    assert.ok(r1.ok, r1.error);
    // a second boundary appends another receipt
    seed(store, 1);
    const head2 = store.chainMeta().head_hash;
    await emitReceipt(target, receipt(A, 4, head2));

    const receipts = readReceipts(target);
    assert.equal(receipts.length, 2);
    const v = verify(store, { trustedPublicKey: A.publicKeyPem, anchors: receipts });
    assert.ok(v.ok, JSON.stringify(v.break));
  } finally {
    store.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- git provider round-trip (real temp repo) ------------------------------
test('git provider: receipts commit to a dedicated ref, read back, and verify', async () => {
  const store = tempStore();
  const repo = mkdtempSync(join(tmpdir(), 'bb-anchor-git-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('commit', '-q', '--allow-empty', '-m', 'init');

    seed(store, 3);
    const A = kp();
    const target = { kind: 'git', repo };
    const out = await emitReceipt(target, receipt(A, 3, store.chainMeta().head_hash));
    assert.ok(out.ok, out.error);

    // the anchor ref exists and the main branch was untouched
    const ref = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', ANCHOR_REF], { encoding: 'utf8' }).trim();
    assert.match(ref, /^[0-9a-f]{40}$/);

    const receipts = readReceipts(target);
    assert.equal(receipts.length, 1);
    assert.ok(verify(store, { trustedPublicKey: A.publicKeyPem, anchors: receipts }).ok);
  } finally {
    store.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- receiptFromSignature reuses the R3 signature verbatim -----------------
test('receiptFromSignature carries the checkpoint tuple + key fingerprint', () => {
  const A = kp();
  const row = { seq: 5, head_hash: 'sha256:' + 'a'.repeat(64), sig: signCheckpoint(5, 'sha256:' + 'a'.repeat(64), TS, A.privateKeyPem), pubkey: A.publicKeyPem, ts: TS };
  const r = receiptFromSignature(row);
  assert.equal(r.v, 1);
  assert.equal(r.seq, 5);
  assert.equal(r.head_hash, row.head_hash);
  assert.equal(r.sig, row.sig);
  assert.equal(r.signed_at, TS);
  assert.equal(r.pubkey_fp, keyFingerprint(A.publicKeyPem));
});
