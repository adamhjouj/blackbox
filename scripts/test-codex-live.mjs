#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'blackbox-codex-live-'));
const repo = join(scratch, 'workspace');
const isolatedHome = join(repo, 'home');
const state = join(isolatedHome, '.blackbox');
const codexHome = join(isolatedHome, '.codex');
const db = join(state, 'blackbox.db');
const configPath = join(state, 'config.json');
const cliPath = join(root, 'dist', 'cli.js');
const hooksPath = join(codexHome, 'hooks.json');
const proofPath = join(repo, 'codex-live-proof.txt');
const codexBin = process.env.BLACKBOX_CODEX_BIN || 'codex';
let daemon;
let store;

function tail(value, max = 4_000) {
  const text = String(value || '');
  return text.length > max ? text.slice(-max) : text;
}

function runCodex(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex live test timed out after 180 seconds'));
    }, 180_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end();
  });
}

try {
  assert.ok(existsSync(cliPath), 'dist/cli.js is missing; run npm run build first');
  const codexVersion = execFileSync(codexBin, ['--version'], { encoding: 'utf8' }).trim();

  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(hooksPath), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '--quiet', repo]);
  const sourceCodexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const sourceAuth = join(sourceCodexHome, 'auth.json');
  assert.ok(existsSync(sourceAuth), `Codex auth is missing at ${sourceAuth}; run codex login first`);
  copyFileSync(sourceAuth, join(codexHome, 'auth.json'));
  chmodSync(join(codexHome, 'auth.json'), 0o600);

  process.env.BLACKBOX_HOME = state;
  process.env.BLACKBOX_DB = db;
  const require = createRequire(import.meta.url);
  const { startDaemon } = require(join(root, 'dist', 'daemon.js'));
  const { Store } = require(join(root, 'dist', 'store.js'));
  const { buildCodexHookConfig } = require(join(root, 'dist', 'codex-init.js'));

  // Provision auth before the daemon opens, then publish its OS-assigned port for
  // the short-lived `blackbox hook codex` processes spawned by the real CLI.
  writeFileSync(configPath, JSON.stringify({ token: 'isolated-live-test' }, null, 2));
  daemon = await startDaemon({ db, port: 0 });
  writeFileSync(configPath, JSON.stringify({ token: 'isolated-live-test', port: daemon.port }, null, 2));
  writeFileSync(hooksPath, JSON.stringify({ hooks: buildCodexHookConfig(process.execPath, cliPath) }, null, 2));

  const prompt = "Use the shell tool exactly once to run: printf 'blackbox-codex-live-ok\\n' > codex-live-proof.txt. Then reply only: done";
  const codexEnv = { ...process.env, HOME: isolatedHome, CODEX_HOME: codexHome };
  delete codexEnv.BLACKBOX_HOME;
  delete codexEnv.BLACKBOX_DB;
  const result = await runCodex([
    'exec',
    '--dangerously-bypass-hook-trust',
    '--enable', 'hooks',
    '--ephemeral',
    '--json',
    '--sandbox', 'workspace-write',
    '--config', 'sandbox_workspace_write.network_access=true',
    '--cd', repo,
    prompt,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: codexEnv,
  });
  if (result.status !== 0) {
    throw new Error(`Codex exited ${result.status}\nstdout:\n${tail(result.stdout)}\nstderr:\n${tail(result.stderr)}`);
  }

  assert.equal(readFileSync(proofPath, 'utf8'), 'blackbox-codex-live-ok\n', 'Codex shell action did not complete');
  store = new Store(db);
  const events = store.events().filter((event) => event.source === 'codex-cli');
  if (events.length === 0) {
    throw new Error(
      'Codex completed but no hooks reached Blackbox' +
      `\nstdout:\n${tail(result.stdout)}\nstderr:\n${tail(result.stderr)}`,
    );
  }
  assert.ok(events.length >= 5, `expected at least five Codex events, got ${events.length}`);
  assert.ok(events.every((event) => event.session_id !== 'unknown'), 'Codex session ids must be stable');
  for (const expected of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert.ok(events.some((event) => event.hook_event === expected), `missing ${expected} event`);
  }
  const pre = events.find((event) => event.hook_event === 'PreToolUse');
  const post = events.find((event) => event.hook_event === 'PostToolUse');
  assert.ok(pre?.tool_use_id, 'PreToolUse is missing a tool_use_id');
  assert.equal(post?.tool_use_id, pre.tool_use_id, 'Codex tool lifecycle did not correlate');
  assert.notEqual(post?.success, 0, 'successful Codex shell action was recorded as a failure');

  const hookEvents = events.map((event) => event.hook_event).join(', ');
  process.stdout.write(
    `Codex live integration OK: ${codexVersion}; ${events.length} local events (${hookEvents}); ` +
    `tool=${pre.tool_name}; outcome=${post?.success === 1 ? 'succeeded' : 'unknown'}\n`,
  );
} finally {
  if (store) store.close();
  if (daemon) await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
}
