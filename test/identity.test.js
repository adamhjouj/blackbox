'use strict';
// AARM R6 — agent identity binding. The assertion must be unforgeable, must notice
// when the chain moves under it, and — the load-bearing property — must be PURELY
// ADDITIVE: existing `blackbox-checkpoint` signatures and verify() are untouched.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  IDENTITY_VERSION,
  checkIdentity,
  checkpointMessage,
  identityMessage,
  recorderId,
  signCheckpoint,
  signIdentity,
  verifyCheckpoint,
  verifyIdentity,
} = require('../dist/sign.js');
const { verify } = require('../dist/verify.js');
const { normEv, tempStore } = require('./util.js');

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function seed(store, sid = 'S') {
  store.append(normEv({ session_id: sid, phase: 'session_start', hook_event: 'SessionStart', action_type: 'session', agent_type: 'main' }));
  store.append(normEv({ session_id: sid, phase: 'pre', hook_event: 'PreToolUse', tool_use_id: 'tu1', tool_name: 'Read', action_type: 'file_read', target: '/repo/a.ts', agent_id: 'ag-1' }));
  store.append(normEv({ session_id: sid, phase: 'session_end', hook_event: 'SessionEnd', action_type: 'session', agent_type: 'main' }));
}

test('identity: recorderId is stable per key and differs across keys', () => {
  const a = keypair();
  const b = keypair();
  assert.match(recorderId(a.publicKeyPem), /^[0-9a-f]{16}$/);
  assert.equal(recorderId(a.publicKeyPem), recorderId(a.publicKeyPem));
  assert.notEqual(recorderId(a.publicKeyPem), recorderId(b.publicKeyPem));
});

test('identity: a signed assertion verifies under its own key and not another', () => {
  const store = tempStore();
  try {
    seed(store);
    const keys = keypair();
    const row = signIdentity(store, 'S', keys, '2026-01-01T00:00:00.000Z');
    assert.ok(row, 'expected an assertion');
    assert.equal(row.identity_version, IDENTITY_VERSION);
    assert.equal(row.recorder_id, recorderId(keys.publicKeyPem));
    assert.deepEqual(JSON.parse(row.agent_ids), ['ag-1']);
    assert.equal(row.first_seq, 1);
    assert.equal(row.last_seq, 3);
    assert.equal(row.head_hash, store.get(3).hash, 'the assertion must commit to the real chain state');

    assert.equal(verifyIdentity(row, keys.publicKeyPem), true);
    assert.equal(verifyIdentity(row, keypair().publicKeyPem), false, 'another key must not validate it');
    assert.deepEqual(checkIdentity(store, row, keys.publicKeyPem), { ok: true, reason: null });
  } finally {
    store.cleanup();
  }
});

test('identity: tampering with any asserted field breaks the signature', () => {
  const store = tempStore();
  try {
    seed(store);
    const keys = keypair();
    const row = signIdentity(store, 'S', keys, '2026-01-01T00:00:00.000Z');
    for (const field of ['session_id', 'recorder_id', 'agent_type', 'first_seq', 'last_seq', 'head_hash']) {
      const forged = { ...row, [field]: typeof row[field] === 'number' ? row[field] + 1 : 'forged' };
      assert.equal(verifyIdentity(forged, keys.publicKeyPem), false, `${field} must be covered by the signature`);
    }
    const forgedAgents = { ...row, agent_ids: JSON.stringify(['ag-2']) };
    assert.equal(verifyIdentity(forgedAgents, keys.publicKeyPem), false, 'agent_ids must be covered');
  } finally {
    store.cleanup();
  }
});

test('identity: a valid signature over a chain that has since changed is reported', () => {
  const store = tempStore();
  try {
    seed(store);
    const keys = keypair();
    const row = signIdentity(store, 'S', keys, '2026-01-01T00:00:00.000Z');
    // The signature is still cryptographically valid, but it no longer describes
    // the store — a stale attestation must not read as a passing one.
    const stale = { ...row, last_seq: 99 };
    const resigned = { ...stale, sig: crypto.sign(null, identityMessage(stale), keys.privateKeyPem).toString('base64') };
    assert.equal(verifyIdentity(resigned, keys.publicKeyPem), true, 'signature itself is valid');
    assert.equal(checkIdentity(store, resigned, keys.publicKeyPem).ok, false);
    assert.equal(checkIdentity(store, resigned, keys.publicKeyPem).reason, 'range-missing');
  } finally {
    store.cleanup();
  }
});

test('identity: the message prefix can never collide with a checkpoint', () => {
  const store = tempStore();
  try {
    seed(store);
    const keys = keypair();
    const row = signIdentity(store, 'S', keys, '2026-01-01T00:00:00.000Z');
    const idMsg = identityMessage(row).toString('utf8');
    assert.ok(idMsg.startsWith('blackbox-identity\n'));
    assert.ok(checkpointMessage(1, 'h', 't').toString('utf8').startsWith('blackbox-checkpoint\n'));
    // A checkpoint signature must not validate as an identity assertion, or vice versa.
    const cp = signCheckpoint(row.last_seq, row.head_hash, row.computed_at, keys.privateKeyPem);
    assert.equal(verifyIdentity({ ...row, sig: cp }, keys.publicKeyPem), false);
  } finally {
    store.cleanup();
  }
});

test('identity: writing an assertion leaves checkpoints and verify() untouched', () => {
  const store = tempStore();
  try {
    seed(store);
    const keys = keypair();
    const meta = store.chainMeta();
    const ts = '2026-01-01T00:00:00.000Z';
    const cpSig = signCheckpoint(meta.head_seq, meta.head_hash, ts, keys.privateKeyPem);
    const before = verify(store, { trustedPublicKey: keys.publicKeyPem });

    signIdentity(store, 'S', keys, ts);

    // The additive guarantee: a pre-existing checkpoint still verifies, and the
    // chain verdict is byte-identical with the new derived table present.
    assert.equal(verifyCheckpoint(meta.head_seq, meta.head_hash, ts, cpSig, keys.publicKeyPem), true);
    assert.deepEqual(verify(store, { trustedPublicKey: keys.publicKeyPem }), before);
    assert.deepEqual(store.chainMeta(), meta, 'the chain head must not move');
  } finally {
    store.cleanup();
  }
});

test('identity: an empty session yields no assertion rather than an empty one', () => {
  const store = tempStore();
  try {
    assert.equal(signIdentity(store, 'nope', keypair(), '2026-01-01T00:00:00.000Z'), null);
  } finally {
    store.cleanup();
  }
});
