'use strict';
// R2 git-anchored reconciliation: join git ground truth (worktree_delta) against the
// hook mutations → ghost / phantom / content_mismatch. Re-derivable, never hashed.
// Acceptance bar: a clean hook-only session yields ZERO findings. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { reconcile, reconcileSession, persistReconciliation, RECON_VERSION } = require('../dist/reconcile.js');
const { captureWorktreeDelta } = require('../dist/worktree.js');
const { normalizeAndCapture, worktreeDeltaEvent, worktreeBaseEvent } = require('../dist/normalize.js');
const { verify } = require('../dist/verify.js');
const { hashString } = require('../dist/hash.js');
const { tempStore } = require('./util.js');

const AT = '2026-02-01T00:00:00.000Z';
// delta files use REPO-RELATIVE paths (git's form); hook mutation targets are ABSOLUTE.
const dfile = (path, status, sha, ins = 1, del = 0) => ({ path, status, insertions: ins, deletions: del, sha256: sha });
const delta = (files) => ({ base: 'base', head: 'head', truncated: false, hash_truncated: false, files });
const mut = (path, kind, content_hash, seq = 2, extra = {}) => ({ path, kind, content_hash, redacted: false, stored: true, seq, ...extra });

// ---- the acceptance bar --------------------------------------------------
test('a clean hook-only session yields ZERO findings', () => {
  const d = delta([dfile('a.ts', 'M', 'sha256:aaa'), dfile('b.ts', 'A', 'sha256:bbb', 5, 0)]);
  const muts = [mut('/repo/a.ts', 'patch', 'sha256:patchA'), mut('/repo/b.ts', 'body', 'sha256:bbb', 4)];
  const r = reconcile(d, muts);
  assert.equal(r.findings.length, 0, 'a clean session must produce no discrepancies');
  assert.equal(r.coverage.corroborated, true);
});

test('suffix matching is symlink / path-prefix immune (the critical false-positive)', () => {
  // git resolves the repo root; the hook target keeps the symlinked prefix — they
  // must still match, or every clean edit under /tmp or /var false-fires.
  const d = delta([dfile('src/auth.ts', 'M', 'sha256:a')]);
  const r = reconcile(d, [mut('/private/var/folders/xyz/checkout/src/auth.ts', 'body', 'sha256:a')]);
  assert.equal(r.findings.length, 0);
});

// ---- the three discrepancy types -----------------------------------------
test('ghost_mutation: a file changed on disk with no file-write/edit hook', () => {
  const d = delta([dfile('a.ts', 'M', 'sha256:aaa'), dfile('ghost.ts', 'A', 'sha256:ggg')]);
  const r = reconcile(d, [mut('/repo/a.ts', 'body', 'sha256:aaa')]);
  const ghosts = r.findings.filter((f) => f.type === 'ghost_mutation');
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].path, 'ghost.ts');
});

test('phantom_mutation: a hook recorded a change not reflected on disk', () => {
  const d = delta([dfile('a.ts', 'M', 'sha256:aaa')]);
  const r = reconcile(d, [mut('/repo/a.ts', 'body', 'sha256:aaa'), mut('/repo/gone.ts', 'body', 'sha256:zzz', 4)]);
  const ph = r.findings.filter((f) => f.type === 'phantom_mutation');
  assert.equal(ph.length, 1);
  assert.equal(ph[0].path, '/repo/gone.ts');
});

test('content_mismatch: an unredacted body write whose on-disk content differs', () => {
  const d = delta([dfile('b.ts', 'A', 'sha256:ONDISK')]);
  const r = reconcile(d, [mut('/repo/b.ts', 'body', 'sha256:HOOKWROTE', 4)]);
  const mm = r.findings.filter((f) => f.type === 'content_mismatch');
  assert.equal(mm.length, 1);
  assert.equal(mm[0].path, 'b.ts');
});

test('a REDACTED body write never content_mismatches (hook hash ≠ raw disk hash by design)', () => {
  const d = delta([dfile('env.ts', 'A', 'sha256:RAWDISK')]);
  const r = reconcile(d, [mut('/repo/env.ts', 'body', 'sha256:REDACTED', 4, { redacted: true })]);
  assert.equal(r.findings.filter((f) => f.type === 'content_mismatch').length, 0);
});

test('an oversize/skipped write (stored:false) never content_mismatches', () => {
  const d = delta([dfile('big.txt', 'A', 'sha256:ONDISK')]);
  const r = reconcile(d, [mut('/repo/big.txt', 'body', 'sha256:HOOKHASH', 4, { stored: false })]);
  assert.equal(r.findings.filter((f) => f.type === 'content_mismatch').length, 0);
});

test("an edit (patch) never content_mismatches (can't reconstruct)", () => {
  const d = delta([dfile('a.ts', 'M', 'sha256:whatever')]);
  const r = reconcile(d, [mut('/repo/a.ts', 'patch', 'sha256:patch')]);
  assert.equal(r.findings.length, 0);
});

// ---- dirty-worktree baseline (pre-existing changes aren't the agent's) ----
test('a file already dirty at session start, unchanged, is NOT a ghost', () => {
  const d = delta([dfile('wip.ts', 'M', 'sha256:same')]);
  const baseline = new Map([['wip.ts', 'sha256:same']]);
  assert.equal(reconcile(d, [], { baseline }).findings.length, 0, 'pre-existing + unchanged → suppressed');
});

test('a file dirty at session start that CHANGED during the session IS a ghost', () => {
  const d = delta([dfile('wip.ts', 'M', 'sha256:end')]);
  const baseline = new Map([['wip.ts', 'sha256:start']]);
  assert.equal(reconcile(d, [], { baseline }).findings.filter((f) => f.type === 'ghost_mutation').length, 1);
});

// ---- truncation + coverage -----------------------------------------------
test('a truncated delta suppresses phantoms and surfaces truncation in coverage', () => {
  const d = { base: 'b', head: 'h', truncated: true, hash_truncated: false, files: [dfile('a.ts', 'M', 'sha256:a')] };
  const r = reconcile(d, [mut('/repo/a.ts', 'body', 'sha256:a'), mut('/repo/not-in-delta.ts', 'body', 'sha256:x', 4)]);
  assert.equal(r.findings.filter((f) => f.type === 'phantom_mutation').length, 0);
  assert.equal(r.coverage.truncated, true);
});

test('no git anchor → uncorroborated, no findings, honest reason', () => {
  const r = reconcile(null, [mut('/repo/a.ts', 'body', 'sha256:x')], { anchorReason: 'not-a-repo' });
  assert.equal(r.coverage.corroborated, false);
  assert.equal(r.coverage.reason, 'not-a-repo');
  assert.equal(r.findings.length, 0);
});

// ---- store integration: re-derivable, chain untouched, baseline honored --
test('reconcileSession joins delta + baseline + mutations; chain byte-identical; rescore idempotent', () => {
  const store = tempStore();
  try {
    // SessionStart anchor + dirty baseline (a pre-existing WIP file)
    const ss = normalizeAndCapture({ hook_event_name: 'SessionStart', session_id: 'S', cwd: '/repo' }, AT, { anchor: { head_sha: 'base1', branch: 'main' } });
    store.append(ss.event, ss.blob);
    store.append(worktreeBaseEvent('S', delta([dfile('wip.ts', 'M', 'sha256:wip')]), AT));
    // a captured hook write to a.ts (disk will match)
    const e = normalizeAndCapture({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/a.ts', content: 'hello\n' }, session_id: 'S', tool_use_id: 't1' }, AT);
    const stored = store.append(e.event, e.blob);
    const h1 = store.get(stored.seq).hash;
    const bodyHash = e.blob.content_hash;
    // end delta: a.ts matches, wip.ts unchanged (baseline suppresses), ghost.ts is the money finding
    store.append(worktreeDeltaEvent('S', delta([dfile('a.ts', 'A', bodyHash, 1, 0), dfile('wip.ts', 'M', 'sha256:wip'), dfile('ghost.ts', 'A', 'sha256:ggg')]), AT));

    const r = reconcileSession(store, 'S');
    const ghosts = r.findings.filter((f) => f.type === 'ghost_mutation');
    assert.equal(ghosts.length, 1, 'only ghost.ts — a.ts matches, wip.ts is pre-existing');
    assert.equal(ghosts[0].path, 'ghost.ts');

    persistReconciliation(store, 'S', AT);
    const first = store.sessionReconciliation('S', RECON_VERSION).findings;
    persistReconciliation(store, 'S', AT); // idempotent
    assert.equal(store.sessionReconciliation('S', RECON_VERSION).findings, first);
    assert.equal(store.get(stored.seq).hash, h1, 'chain untouched');
    assert.ok(verify(store).ok);
  } finally {
    store.cleanup();
  }
});

test('store.sessionBaseSha reads the SessionStart anchor head_sha', () => {
  const store = tempStore();
  try {
    const e = normalizeAndCapture({ hook_event_name: 'SessionStart', session_id: 'S', cwd: '/r' }, AT, { anchor: { head_sha: 'abc123', branch: 'main' } });
    store.append(e.event, e.blob);
    assert.equal(store.sessionBaseSha('S'), 'abc123');
    assert.equal(store.sessionBaseSha('NOPE'), null);
  } finally {
    store.cleanup();
  }
});

// ---- worktree capture against a real git repo (incl. a rename) -----------
test('captureWorktreeDelta reports modified + untracked + renamed files (repo-relative)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bb-wt-'))); // resolve macOS /var→/private/var
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  writeFileSync(join(dir, 'old.txt'), 'renameme\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'a.txt'), 'world\n'); // modify tracked
  writeFileSync(join(dir, 'b.txt'), 'new file\n'); // untracked
  git('mv', 'old.txt', 'new.txt'); // rename

  const d = captureWorktreeDelta(dir, base);
  assert.ok(d, 'delta computed for a valid repo');
  const byBase = Object.fromEntries(d.files.map((f) => [f.path.split('/').pop(), f]));
  assert.ok(byBase['a.txt'] && byBase['a.txt'].status === 'M', 'a.txt modified');
  assert.equal(byBase['a.txt'].path, 'a.txt', 'delta path is repo-relative');
  assert.equal(byBase['a.txt'].sha256, hashString('world\n'), 'faithful on-disk hash');
  assert.ok(byBase['b.txt'] && byBase['b.txt'].status === '?', 'b.txt untracked-new');
  assert.ok(byBase['new.txt'], 'renamed new path present');
  // a bogus base / no cwd → null (uncorroborated), never throws
  assert.equal(captureWorktreeDelta(dir, '0'.repeat(40)), null);
  assert.equal(captureWorktreeDelta(null, base), null);
});
