'use strict';
// W0.3 — SCHEMA_VERSION is now READ on open, not only written. A store written by
// a newer blackbox (higher user_version) must be refused before this build touches
// it, so an old binary can't ALTER/re-stamp a hash-format it can't reproduce.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { Store } = require('../dist/store.js');
const { normEv } = require('./util.js');

function tmpPath() {
  return path.join(os.tmpdir(), `bbver-${process.pid}-${crypto.randomUUID().slice(0, 8)}.db`);
}
function cleanup(p) {
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(p + ext, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

test('a fresh store stamps user_version to the current SCHEMA_VERSION', () => {
  const p = tmpPath();
  try {
    const store = new Store(p);
    store.append(normEv({ phase: 'session_start', hook_event: 'SessionStart' }));
    store.close();
    const raw = new Database(p, { readonly: true });
    assert.equal(raw.pragma('user_version', { simple: true }), 1);
    raw.close();
  } finally {
    cleanup(p);
  }
});

test('a store from a NEWER blackbox (user_version > current) is refused', () => {
  const p = tmpPath();
  try {
    // materialise a real store, then bump its on-disk version as a future build would
    const store = new Store(p);
    store.append(normEv({ phase: 'session_start', hook_event: 'SessionStart' }));
    store.close();
    const raw = new Database(p);
    raw.pragma('user_version = 99');
    raw.close();

    assert.throws(() => new Store(p), /schema version 99/i);
  } finally {
    cleanup(p);
  }
});

test('a legacy store (user_version 0 with data) opens and is re-stamped', () => {
  const p = tmpPath();
  try {
    const store = new Store(p);
    store.append(normEv({ phase: 'session_start', hook_event: 'SessionStart' }));
    store.close();
    // simulate a pre-stamping DB: data present, version reset to 0
    const raw = new Database(p);
    raw.pragma('user_version = 0');
    raw.close();

    const reopened = new Store(p); // must NOT throw
    assert.equal(reopened.head().seq, 1, 'existing data should still be readable');
    reopened.close();
    const check = new Database(p, { readonly: true });
    assert.equal(check.pragma('user_version', { simple: true }), 1, 're-stamped to current');
    check.close();
  } finally {
    cleanup(p);
  }
});
