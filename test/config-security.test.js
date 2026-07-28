'use strict';
// Local-state security invariants. Requires dist/ (`npm run build`). Every path is
// throwaway; no test reads or writes the user's real ~/.blackbox directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { MalformedConfigError, readConfig, writeConfig, writePrivateFileAtomic } = require('../dist/config.js');
const { anchorDisplayDestination, loadAnchorConfig, setAnchorTarget } = require('../dist/anchor.js');
const { ensureKeypair, writeWatermark } = require('../dist/sign.js');
const { ensureBlackboxDir } = require('../dist/paths.js');

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const mode = (path) => statSync(path).mode & 0o777;

test('ensureBlackboxDir creates and migrates the state directory to 0700', () => {
  const old = process.env.BLACKBOX_HOME;
  const parent = temp('bb-state-parent-');
  const state = join(parent, 'state');
  try {
    process.env.BLACKBOX_HOME = state;
    assert.equal(ensureBlackboxDir(), state);
    assert.equal(mode(state), 0o700);
    chmodSync(state, 0o755);
    ensureBlackboxDir();
    assert.equal(mode(state), 0o700, 'an existing permissive install is tightened');
  } finally {
    if (old === undefined) delete process.env.BLACKBOX_HOME;
    else process.env.BLACKBOX_HOME = old;
    rmSync(parent, { recursive: true, force: true });
  }
});

test('config writes are atomic/private and preserve unknown fields', () => {
  const dir = temp('bb-config-write-');
  try {
    const path = join(dir, 'config.json');
    writeConfig({ token: 'abc', future_setting: { enabled: true } }, path);
    assert.equal(mode(path), 0o600);
    assert.deepEqual(readConfig(path), { token: 'abc', future_setting: { enabled: true } });
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false, 'no temporary file remains');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed config is backed up byte-for-byte and rejected without replacement', () => {
  const dir = temp('bb-config-bad-');
  try {
    const path = join(dir, 'config.json');
    const raw = '{"token":"live-secret", this is broken\n';
    writeFileSync(path, raw, { mode: 0o644 });
    let caught;
    try {
      readConfig(path);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof MalformedConfigError);
    assert.equal(readFileSync(path, 'utf8'), raw, 'the corrupt source is never replaced');
    assert.equal(mode(path), 0o600, 'even the corrupt token-bearing source is made private');
    assert.equal(readFileSync(caught.backupPath, 'utf8'), raw);
    assert.equal(mode(caught.backupPath), 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-object JSON config is malformed and fails closed', () => {
  const dir = temp('bb-config-shape-');
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, '[{"token":"not-a-config"}]');
    assert.throws(() => readConfig(path), MalformedConfigError);
    assert.match(readFileSync(path, 'utf8'), /^\[/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anchor config never overwrites malformed JSON', () => {
  const dir = temp('bb-anchor-bad-config-');
  try {
    const path = join(dir, 'config.json');
    const raw = '{bad';
    writeFileSync(path, raw);
    assert.throws(() => loadAnchorConfig(path), MalformedConfigError);
    assert.equal(readFileSync(path, 'utf8'), raw);
    assert.throws(() => setAnchorTarget('file:/tmp/receipts', path), MalformedConfigError);
    assert.equal(readFileSync(path, 'utf8'), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anchor config writes are 0600 and display URLs cannot disclose credentials', () => {
  const dir = temp('bb-anchor-display-');
  try {
    const path = join(dir, 'config.json');
    setAnchorTarget('https://user:password@example.test/private/token?api_key=secret#fragment', path);
    assert.equal(mode(path), 0o600);
    const target = loadAnchorConfig(path).target;
    assert.ok(target);
    const display = anchorDisplayDestination(target);
    assert.equal(display, 'https://example.test');
    for (const secret of ['user', 'password', 'private', 'token', 'api_key', 'secret', 'fragment']) {
      assert.equal(display.includes(secret), false, `display omits ${secret}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an incomplete signing keypair fails closed without touching its survivor', () => {
  for (const survivor of ['signing.key', 'signing.pub']) {
    const dir = temp('bb-key-partial-');
    try {
      const path = join(dir, survivor);
      const sentinel = `do-not-overwrite-${survivor}`;
      writeFileSync(path, sentinel);
      assert.throws(() => ensureKeypair(dir), /incomplete signing keypair/);
      assert.equal(readFileSync(path, 'utf8'), sentinel);
      const missing = survivor === 'signing.key' ? 'signing.pub' : 'signing.key';
      assert.equal(existsSync(join(dir, missing)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('existing signing files and watermark are migrated/written as 0600', () => {
  const dir = temp('bb-key-modes-');
  try {
    ensureKeypair(dir);
    chmodSync(join(dir, 'signing.key'), 0o644);
    chmodSync(join(dir, 'signing.pub'), 0o644);
    ensureKeypair(dir);
    assert.equal(mode(join(dir, 'signing.key')), 0o600);
    assert.equal(mode(join(dir, 'signing.pub')), 0o600);
    writeWatermark(dir, { seq: 4, head_hash: 'sha256:' + 'a'.repeat(64) });
    assert.equal(mode(join(dir, 'signing.head')), 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no-clobber private writes preserve existing material', () => {
  const dir = temp('bb-private-no-clobber-');
  try {
    const path = join(dir, 'material');
    writePrivateFileAtomic(path, 'first', { overwrite: false });
    assert.throws(() => writePrivateFileAtomic(path, 'second', { overwrite: false }), /EEXIST/);
    assert.equal(readFileSync(path, 'utf8'), 'first');
    assert.equal(mode(path), 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
