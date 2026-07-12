'use strict';
// R3 chain-of-custody: Ed25519 signatures over the chain head turn tamper-evidence
// into tamper-resistance. Signing is DERIVED from the chain and stored outside it,
// so verify() is byte-identical before/after. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { statSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { verify } = require('../dist/verify.js');
const { signHead, signCheckpoint, ensureKeypair, isSignableBoundary } = require('../dist/sign.js');
const { buildForensicReport } = require('../dist/report.js');
const { hashString } = require('../dist/hash.js');
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

test('signHead then verify under the trusted key passes', () => {
  const store = tempStore();
  try {
    seed(store);
    const A = kp();
    const row = signHead(store, A, TS);
    assert.ok(row && row.seq === store.chainMeta().head_seq);
    assert.equal(store.signatures().length, 1);
    const v = verify(store, { trustedPublicKey: A.publicKeyPem });
    assert.ok(v.ok, 'verify should pass under the signing key');
  } finally {
    store.cleanup();
  }
});

test('a checkpoint signed by a non-trusted key is flagged (rewrite + re-sign with wrong key)', () => {
  const store = tempStore();
  try {
    seed(store);
    const A = kp(); // the key the user trusts
    const B = kp(); // the attacker's key
    signHead(store, A, TS);
    assert.ok(verify(store, { trustedPublicKey: A.publicKeyPem }).ok);

    // Attacker rewrites the chain consistently (internal walk still passes) and
    // re-signs the head with THEIR key, overwriting the checkpoint.
    const meta = store.chainMeta();
    const forged = signCheckpoint(meta.head_seq, meta.head_hash, TS, B.privateKeyPem);
    store.signatureUpsert({ seq: meta.head_seq, head_hash: meta.head_hash, sig: forged, pubkey: B.publicKeyPem, ts: TS });

    const v = verify(store, { trustedPublicKey: A.publicKeyPem });
    assert.equal(v.ok, false);
    assert.equal(v.break.reason, 'signature-invalid');
  } finally {
    store.cleanup();
  }
});

test('verify() with no trusted key ignores signatures (backward compatible)', () => {
  const store = tempStore();
  try {
    seed(store);
    const B = kp();
    const meta = store.chainMeta();
    // a bogus (untrusted) signature present in the store
    store.signatureUpsert({ seq: meta.head_seq, head_hash: meta.head_hash, sig: signCheckpoint(meta.head_seq, meta.head_hash, TS, B.privateKeyPem), pubkey: B.publicKeyPem, ts: TS });
    assert.ok(verify(store).ok, 'no-key verify must not check signatures');
  } finally {
    store.cleanup();
  }
});

test('signing is byte-identical to the chain (head hash + verify unchanged)', () => {
  const store = tempStore();
  try {
    seed(store);
    const headBefore = store.chainMeta().head_hash;
    assert.ok(verify(store).ok);
    signHead(store, kp(), TS);
    assert.equal(store.chainMeta().head_hash, headBefore, 'signing must not change the head');
    assert.ok(verify(store).ok, 'chain still verifies after signing');
  } finally {
    store.cleanup();
  }
});

test('the forensic case-file bundles custody + a valid self-manifest', () => {
  const store = tempStore();
  try {
    seed(store);
    const A = kp();
    signHead(store, A, TS);
    const doc = buildForensicReport(store, 'S', { trustedPublicKey: A.publicKeyPem, generatedAt: TS });
    assert.ok(doc.includes('## Chain of custody'));
    assert.ok(doc.includes('Integrity:** ✓'));
    assert.ok(doc.includes('Signature:** Ed25519'));
    assert.ok(doc.includes('verifies under the trusted key'));
    // the manifest is a real sha-256 of everything above it
    const [body, tail] = doc.split('\n\n---\n**Manifest (sha-256 of everything above this line):** `');
    const manifest = tail.split('`')[0];
    assert.equal(hashString(body), manifest, 'manifest must equal sha-256 of the case-file body');
  } finally {
    store.cleanup();
  }
});

test('a secret in a mutated file never appears in the case-file (redaction)', () => {
  const store = tempStore();
  try {
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const { event, blob } = normalizeAndCapture(
      { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/cfg.ts', old_string: 'k=""', new_string: 'k="' + key + '"' }, session_id: 'S', tool_use_id: 'tu9', cwd: '/r' },
      TS,
    );
    store.append(event, blob);
    signHead(store, kp(), TS);
    const doc = buildForensicReport(store, 'S', { generatedAt: TS });
    assert.ok(!doc.includes(key), 'secret leaked into the forensic case-file');
  } finally {
    store.cleanup();
  }
});

test('signHead is idempotent on the same head; a no-op on an empty chain; a new head adds a row', () => {
  const store = tempStore();
  try {
    const A = kp();
    assert.equal(signHead(store, A, TS), null, 'empty chain → no signature');
    seed(store, 2);
    signHead(store, A, TS);
    signHead(store, A, '2026-03-01T00:00:00.000Z'); // same head → not re-signed
    assert.equal(store.signatures().length, 1);
    seed(store, 1); // advance the head
    signHead(store, A, TS);
    assert.equal(store.signatures().length, 2, 'a new head gets its own checkpoint');
    assert.equal(store.latestSignature().seq, store.chainMeta().head_seq);
  } finally {
    store.cleanup();
  }
});

test('verify flags a signed checkpoint whose event was truncated away (below a signed head)', () => {
  const store = tempStore();
  try {
    seed(store, 3);
    const A = kp();
    const ghostSeq = store.chainMeta().head_seq + 5; // a signed head beyond the (rolled-back) chain
    const headHash = 'sha256:' + 'a'.repeat(64);
    store.signatureUpsert({ seq: ghostSeq, head_hash: headHash, sig: signCheckpoint(ghostSeq, headHash, TS, A.privateKeyPem), pubkey: A.publicKeyPem, ts: TS });
    const v = verify(store, { trustedPublicKey: A.publicKeyPem });
    assert.equal(v.ok, false);
    assert.equal(v.break.reason, 'signature-invalid');
    assert.equal(v.break.seq, ghostSeq);
    assert.match(v.break.detail, /truncated below a signed head/);
  } finally {
    store.cleanup();
  }
});

test('verify flags content altered after signing (valid-key signature, event hash no longer matches)', () => {
  const store = tempStore();
  try {
    seed(store, 3);
    const A = kp();
    const S = 1;
    const bogus = 'sha256:' + 'b'.repeat(64); // a hash the attacker genuinely signs, but the event doesn't have
    store.signatureUpsert({ seq: S, head_hash: bogus, sig: signCheckpoint(S, bogus, TS, A.privateKeyPem), pubkey: A.publicKeyPem, ts: TS });
    const v = verify(store, { trustedPublicKey: A.publicKeyPem });
    assert.equal(v.ok, false);
    assert.equal(v.break.reason, 'signature-invalid');
    assert.match(v.break.detail, /altered after signing/);
  } finally {
    store.cleanup();
  }
});

test('the out-of-DB watermark catches signature deletion/rollback (the DELETE-FROM-signatures attack)', () => {
  const store = tempStore();
  try {
    seed(store, 3);
    const A = kp();
    const row = signHead(store, A, TS);
    const good = { seq: row.seq, head_hash: row.head_hash };
    // With the real watermark, verify passes.
    assert.ok(verify(store, { trustedPublicKey: A.publicKeyPem, watermark: good }).ok);
    // The watermark records a head whose signature is no longer in the DB (deleted/
    // rolled back) — verify must fail even though every remaining signature is valid.
    const rolled = { seq: row.seq, head_hash: 'sha256:' + 'c'.repeat(64) };
    const v = verify(store, { trustedPublicKey: A.publicKeyPem, watermark: rolled });
    assert.equal(v.ok, false);
    assert.equal(v.break.reason, 'signature-invalid');
    assert.match(v.break.detail, /deleted or rolled back/);
  } finally {
    store.cleanup();
  }
});

test('isSignableBoundary matches session boundaries only', () => {
  for (const p of ['session_start', 'session_end', 'stop']) assert.equal(isSignableBoundary(p), true, p);
  for (const p of ['pre', 'post', 'failure', 'prompt', 'other']) assert.equal(isSignableBoundary(p), false, p);
});

test('ensureKeypair is idempotent and writes a 0600 private key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-sign-'));
  const a = ensureKeypair(dir);
  const b = ensureKeypair(dir);
  assert.equal(a.publicKeyPem, b.publicKeyPem, 'second call reuses the same key');
  const mode = statSync(join(dir, 'signing.key')).mode & 0o777;
  assert.equal(mode, 0o600, 'private key must be 0600');
});
