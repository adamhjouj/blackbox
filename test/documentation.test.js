'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('current product documentation matches the shipped capability contract', () => {
  const readme = read('README.md');
  const architecture = read('docs/ARCHITECTURE.md');
  const security = read('SECURITY.md');
  const changelog = read('CHANGELOG.md');
  const pkg = JSON.parse(read('package.json'));

  for (const text of [readme, architecture]) {
    assert.match(text, /Gemini CLI/);
    assert.match(text, /Codex CLI/);
    assert.match(text, /Review Inbox/);
    assert.match(text, /attestation/i);
    assert.match(text, /local/i);
  }
  assert.match(security, /Gemini/);
  assert.match(security, /Codex/);
  assert.match(security, /review/i);
  assert.match(security, /attestation/i);
  assert.match(security, /local/i);
  assert.match(readme, /npx --yes blackbox-recorder@beta install/);
  assert.match(readme, /Node(?:\.js)? `22`, `24`, or `26`|Node 22 · 24 · 26/);
  assert.match(readme, /attempted, succeeded, failed, or unknown/);
  assert.match(readme, /Baselines never remove evidence/);
  assert.match(readme, /--trusted-key/);
  assert.match(readme, /--expected-commit/);
  assert.match(changelog, /Review Inbox/);
  assert.doesNotMatch(pkg.description, /Claude Code first/i);
  assert.ok(pkg.keywords.includes('gemini-cli'));
  assert.ok(pkg.keywords.includes('codex-cli'));
  assert.ok(pkg.keywords.includes('attestation'));
});

test('CLI help documents the attestation trust and revision controls', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'dist', 'cli.js'), 'help', '--all'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--trusted-key', '--expected-commit', '--github-output', '--fail-on']) {
    assert.match(result.stdout, new RegExp(flag));
  }
  assert.doesNotMatch(result.stdout, /the only egress/i);
});

test('website is semantic, self-contained, responsive, and internally navigable', () => {
  const html = read('docs/index.html');
  assert.match(html, /<meta\s+name="viewport"/i);
  assert.match(html, /@media\s*\([^)]*max-width/i);
  assert.match(html, /synthetic/i);
  assert.match(html, /Gemini CLI/);
  assert.match(html, /Codex CLI/);
  assert.match(html, /Review Inbox/);
  assert.match(html, /blackbox-recorder@beta install/);
  assert.match(html, /published under the npm/);
  assert.match(html, /--local-only-anchor/);
  assert.match(html, /--trusted-key/);
  assert.match(html, /--expected-commit/);
  assert.match(html, /GitHub Actions writes aggregate metadata/);
  assert.doesNotMatch(html, /Uncorroborated file mutation|Git discrepancy/);
  assert.doesNotMatch(html, /#investigation-model/);
  assert.doesNotMatch(html, /<script\s+src=/i);
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/i);

  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const fragments = [...html.matchAll(/\shref="#([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.size, [...html.matchAll(/\sid="([^"]+)"/g)].length, 'HTML ids must be unique');
  for (const fragment of fragments) assert.ok(ids.has(fragment), `missing fragment target #${fragment}`);
});
