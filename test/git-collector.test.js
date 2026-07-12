'use strict';
// A git commit subject/author can carry a secret, and it flows into the shareable
// report + forensic case-file — so it must be redacted before persistence. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGit } = require('../dist/git-collector.js');

test('normalizeGit redacts a secret in the commit subject/author before persistence', () => {
  const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const ev = normalizeGit({
    repoTop: '/repo',
    delta: { ref: 'refs/heads/main', old: '0'.repeat(40), new: 'a'.repeat(40) },
    cls: { kind: 'commit', is_force: false, is_reset: false, is_delete: false, is_amend: false },
    diff: { files: 1, insertions: 1, deletions: 0 },
    commit: { sha: 'a'.repeat(40), author: 'Dev <' + key + '@x.io>', subject: 'stash key ' + key, ts: '2026-02-01T00:00:00Z' },
    correlation: { confidence: 'none', session_id: 'S', tool_use_id: null, candidates: [] },
    rawBody: 'x',
    capturedAt: '2026-02-01T00:00:00.000Z',
  });
  assert.ok(!ev.detail.includes(key), 'secret leaked into the stored git detail');
  const d = JSON.parse(ev.detail);
  assert.ok(d.git.commit.subject.includes('[REDACTED'), 'commit subject should be redacted');
  assert.ok(d.git.commit.author.includes('[REDACTED'), 'commit author should be redacted');
  assert.equal(d.git.commit.sha, 'a'.repeat(40), 'sha is not a secret — kept verbatim');
});
