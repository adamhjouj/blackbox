'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeCodexHooks, removeCodexHooks } = require('../dist/codex-init.js');
const { codexAdapterReadiness } = require('../dist/readiness.js');

test('Codex readiness requires the CLI and every configured Blackbox hook', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-codex-ready-'));
  const bin = path.join(root, 'bin');
  const hooksPath = path.join(root, 'hooks.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldHooks = process.env.BLACKBOX_CODEX_HOOKS;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  process.env.BLACKBOX_CODEX_HOOKS = hooksPath;
  try {
    fs.writeFileSync(hooksPath, JSON.stringify(mergeCodexHooks({}, '/n', '/c').file));
    const ready = codexAdapterReadiness();
    assert.equal(ready.installed, true);
    assert.equal(ready.connected, true);
    assert.match(ready.detail, /all 11 hooks configured/);

    const incomplete = removeCodexHooks(JSON.parse(fs.readFileSync(hooksPath, 'utf8'))).file;
    fs.writeFileSync(hooksPath, JSON.stringify(incomplete));
    assert.equal(codexAdapterReadiness().connected, false);

    fs.writeFileSync(hooksPath, '{ malformed');
    assert.match(codexAdapterReadiness().detail, /malformed/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHooks === undefined) delete process.env.BLACKBOX_CODEX_HOOKS;
    else process.env.BLACKBOX_CODEX_HOOKS = oldHooks;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
