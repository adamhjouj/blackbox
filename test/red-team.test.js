'use strict';
// #1 — RED-TEAM HARNESS. The product's central claim is "the agent can't silently
// blind the recorder." The other suites fire each predicate in isolation; this one
// mounts a MOTIVATED, ESCALATING adversary against a real signed + anchored chain
// and asserts each rung is caught (or documents the exact, stated ceiling). It is
// the end-to-end proof of the custody spine: internal hash chain → local Ed25519
// signing → out-of-band watermark → off-machine anchor receipt. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { generateKeyPairSync } = require('node:crypto');
const { GENESIS, hashEvent } = require('../dist/hash.js');
const { verify } = require('../dist/verify.js');
const { signHead } = require('../dist/sign.js');
const { receiptFromSignature } = require('../dist/anchor.js');
const { evaluateEvent, newRuleCtx, isRecorderTamper } = require('../dist/risk-rules.js');
const { ev, normEv, tempStore } = require('./util.js');

const TS = '2026-01-01T00:00:00.000Z';

function mkKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/** A real 5-event chain, signed at the head, with an off-machine receipt captured
 *  BEFORE any tampering (the surviving witness the attacker can't reach). */
function signedChain() {
  const store = tempStore();
  for (let i = 0; i < 5; i++) store.append(normEv({ session_id: 'RT', action_type: 'file_read', target: `src/f${i}.ts` }));
  const keys = mkKeys();
  const sig = signHead(store, keys, TS);
  const receipt = receiptFromSignature(sig); // shipped off-machine at this point
  const watermark = { seq: sig.seq, head_hash: sig.head_hash };
  return { store, keys, pub: keys.publicKeyPem, receipt, watermark };
}

/** Raw 2nd connection — the attacker with direct write access to blackbox.db. */
function raw(store, fn) {
  const db = new Database(store.dbPath);
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Re-hash the whole chain into internal consistency after an edit — exactly what a
 *  competent attacker does so the bare hash-chain walk can't see the rewrite. Mirrors
 *  verify()'s recomputation ({...row} minus hash → hashEvent), so a rebuilt chain
 *  passes verify(store) with NO key. */
function rehash(store) {
  raw(store, (db) => {
    const rows = db.prepare('SELECT * FROM events ORDER BY seq ASC').all();
    const upd = db.prepare('UPDATE events SET hash=@hash, prev_hash=@prev WHERE seq=@seq');
    let prev = GENESIS;
    for (const row of rows) {
      const { hash, ...rest } = row;
      rest.prev_hash = prev;
      const h = hashEvent(rest);
      upd.run({ hash: h, prev, seq: row.seq });
      prev = h;
    }
    const last = rows[rows.length - 1];
    db.prepare('UPDATE chain_meta SET count=@c, head_seq=@s, head_hash=@h WHERE id = 1').run({ c: rows.length, s: last.seq, h: prev });
  });
}

/** Attacker clears the signatures table and re-signs the (rewritten) head with `keys`
 *  — either their own key, or the real key if they stole it from ~/.blackbox. */
function resign(store, keys) {
  raw(store, (db) => db.prepare('DELETE FROM signatures').run());
  return signHead(store, keys, '2026-02-02T00:00:00.000Z');
}

// ── baseline: an untampered signed+anchored chain verifies clean ─────────────
test('baseline: the signed, anchored chain verifies clean', () => {
  const { store, pub, receipt, watermark } = signedChain();
  try {
    const r = verify(store, { trustedPublicKey: pub, watermark, anchors: [receipt] });
    assert.equal(r.ok, true);
    assert.equal(r.count, 5);
  } finally {
    store.cleanup();
  }
});

// ── rung 1: a naive content edit is caught by the internal chain alone ────────
test('rung 1 — naive content edit ⇒ content-tampered (no key needed)', () => {
  const { store } = signedChain();
  try {
    raw(store, (db) => db.prepare("UPDATE events SET target='exfil.example.com' WHERE seq = 3").run());
    const r = verify(store);
    assert.equal(r.ok, false);
    assert.equal(r.break.reason, 'content-tampered');
    assert.equal(r.break.seq, 3);
  } finally {
    store.cleanup();
  }
});

// ── rung 2: a CONSISTENT rewrite defeats the bare chain — signing catches it ──
test('rung 2 — consistent rewrite blinds the bare chain, but the signed head catches it', () => {
  const { store, pub } = signedChain();
  try {
    raw(store, (db) => db.prepare("UPDATE events SET target='exfil.example.com' WHERE seq = 3").run());
    rehash(store);
    // The attacker succeeded against the hash chain alone:
    assert.equal(verify(store).ok, true, 'a rehashed rewrite is internally consistent — the bare walk cannot see it');
    // …but the original signature commits to the old head hash, so with the trusted
    // key the rewrite is exposed:
    const r = verify(store, { trustedPublicKey: pub });
    assert.equal(r.ok, false);
    assert.equal(r.break.reason, 'signature-invalid');
  } finally {
    store.cleanup();
  }
});

// ── rung 3: re-signing with the attacker's OWN key can't launder the rewrite ──
test('rung 3 — attacker re-signs with their own key ⇒ signature-invalid', () => {
  const { store, pub } = signedChain();
  try {
    raw(store, (db) => db.prepare("UPDATE events SET target='exfil.example.com' WHERE seq = 3").run());
    rehash(store);
    resign(store, mkKeys()); // a DIFFERENT keypair — the attacker lacks the trusted key
    const r = verify(store, { trustedPublicKey: pub });
    assert.equal(r.ok, false);
    assert.equal(r.break.reason, 'signature-invalid');
  } finally {
    store.cleanup();
  }
});

// ── rung 4: the crown jewel — a full-~/.blackbox key thief blinds LOCAL verify,
//    but the off-machine receipt they couldn't reach still proves the rewrite ───
test('rung 4 — full key theft blinds local custody; the off-machine anchor still catches it', () => {
  const { store, keys, pub, receipt } = signedChain();
  try {
    raw(store, (db) => db.prepare("UPDATE events SET target='exfil.example.com' WHERE seq = 3").run());
    rehash(store);
    const newSig = resign(store, keys); // attacker STOLE the real key and re-signs consistently
    const newWatermark = { seq: newSig.seq, head_hash: newSig.head_hash };

    // THE HONEST LIMIT: with everything local re-signed under the stolen key, local
    // verification is fully blinded — this is exactly why local signing isn't enough.
    assert.equal(verify(store, { trustedPublicKey: pub, watermark: newWatermark }).ok, true,
      'a full ~/.blackbox writer who steals the key defeats all LOCAL custody (stated limit)');

    // THE CLOSE: the receipt shipped off-machine BEFORE the rewrite commits to the
    // old head hash and cannot be re-signed away — it proves the rewrite.
    const r = verify(store, { trustedPublicKey: pub, watermark: newWatermark, anchors: [receipt] });
    assert.equal(r.ok, false);
    assert.equal(r.break.reason, 'anchor-mismatch');
    assert.equal(r.break.seq, receipt.seq);
  } finally {
    store.cleanup();
  }
});

// ── rung 5: deleting the newest events is caught by the head anchor ───────────
test('rung 5 — tail truncation ⇒ truncated (the head anchor catches a deleted tail)', () => {
  const { store } = signedChain();
  try {
    raw(store, (db) => db.prepare('DELETE FROM events WHERE seq > 3').run()); // chain_meta still says 5
    const r = verify(store);
    assert.equal(r.ok, false);
    assert.equal(r.break.reason, 'truncated');
  } finally {
    store.cleanup();
  }
});

// ── rung 6: attacking the recorder is itself flagged — and its stated ceiling ─
test('rung 6 — the recorder-stop attempt is flagged (recorder-tamper)', () => {
  const hits = evaluateEvent(ev(1, { action_type: 'shell_command', target: 'blackbox stop' }), newRuleCtx(), 'r4');
  assert.ok(hits.some((h) => h.flag === 'recorder-tamper'), 'stopping the recorder is anti-forensics signal');
});

test('rung 6 — padding a command past the 500cp cap evades the rule (documented ceiling)', () => {
  const full = 'echo ' + 'A'.repeat(600) + ' ; blackbox stop';
  const stored = full.slice(0, 500); // what normalize() truncates `target` to
  // The full command IS a tamper…
  assert.ok(isRecorderTamper(ev(1, { action_type: 'shell_command', target: full })));
  // …but padded past 500cp it no longer fires on the stored target. This is the
  // stated limit, not a silent gap: the ACT is still recorded, and the full command
  // survives in the hashed `raw`. (Upgrade path: scan `raw`, not just `target`.)
  const evaded = evaluateEvent(ev(1, { action_type: 'shell_command', target: stored }), newRuleCtx(), 'r4');
  assert.equal(evaded.some((h) => h.flag === 'recorder-tamper'), false);
});
