'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { Store } = require('../dist/store.js');
const { verify } = require('../dist/verify.js');
const { normEv } = require('./util.js');

test('review decisions append outside the immutable evidence chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-review-ledger-'));
  const db = join(dir, 'events.db');
  try {
    const store = new Store(db);
    const event = store.append(normEv({ session_id: 'S1', phase: 'pre', hook_event: 'PreToolUse' }));
    const before = { head: store.chainMeta(), verification: verify(store), event: store.get(event.seq) };
    store.reviewAppend({
      id: randomUUID(),
      session_id: 'S1',
      finding_key: 'sha256:finding',
      disposition: 'acknowledged',
      note: 'reviewed',
      reviewed_through_seq: event.seq,
      reviewed_through_hash: event.hash,
      policy_hash: null,
      created_at: '2026-07-28T00:00:00.000Z',
    });
    store.reviewAppend({
      id: randomUUID(),
      session_id: 'S1',
      finding_key: 'sha256:finding',
      disposition: 'false_positive',
      note: null,
      reviewed_through_seq: event.seq,
      reviewed_through_hash: event.hash,
      policy_hash: null,
      created_at: '2026-07-28T00:00:01.000Z',
    });
    assert.equal(store.reviewCount(), 2);
    assert.deepEqual(store.reviewsForSession('S1').map((row) => row.disposition), ['acknowledged', 'false_positive']);
    assert.deepEqual(store.chainMeta(), before.head);
    assert.deepEqual(store.get(event.seq), before.event);
    assert.deepEqual(verify(store), before.verification);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a legacy store adds the review ledger without rewriting evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-review-migration-'));
  const db = join(dir, 'events.db');
  try {
    let store = new Store(db);
    const event = store.append(normEv({ session_id: 'LEGACY', phase: 'pre', hook_event: 'PreToolUse' }));
    const before = { head: store.chainMeta(), event: store.get(event.seq) };
    store.close();

    const legacy = new Database(db);
    legacy.exec('DROP TABLE review_actions');
    legacy.close();

    store = new Store(db);
    assert.equal(store.reviewCount(), 0, 'the additive migration creates an empty review ledger');
    assert.deepEqual(store.chainMeta(), before.head);
    assert.deepEqual(store.get(event.seq), before.event);
    assert.deepEqual(verify(store), { ok: true, count: 1, sessions: 1, anchored: true });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
