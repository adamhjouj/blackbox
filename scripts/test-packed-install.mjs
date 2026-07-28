#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'blackbox-packed-install-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const isolatedEnv = { ...process.env, npm_config_cache: join(scratch, 'npm-cache') };
let activated = false;
let installedBin = '';
let activationEnv = isolatedEnv;

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

try {
  const packed = JSON.parse(
    execFileSync(npm, ['pack', '--json', '--pack-destination', scratch], {
      cwd: root,
      encoding: 'utf8',
      env: isolatedEnv,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  const filename = packed?.[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack did not report a tarball filename');
  const tarball = join(scratch, filename);
  if (!existsSync(tarball)) throw new Error(`packed tarball is missing: ${tarball}`);
  const files = new Set((packed[0].files ?? []).map((file) => file.path));
  if (!files.has('dist/cli.js')) throw new Error('packed tarball is missing dist/cli.js');

  execFileSync(npm, ['init', '--yes'], { cwd: scratch, env: isolatedEnv, stdio: 'ignore' });
  execFileSync(npm, ['install', '--no-audit', '--no-fund', tarball], { cwd: scratch, env: isolatedEnv, stdio: 'inherit' });
  installedBin = join(scratch, 'node_modules', '.bin', process.platform === 'win32' ? 'blackbox.cmd' : 'blackbox');
  const state = join(scratch, 'state');
  const fakeBin = join(scratch, 'fake-bin');
  const claudeSettings = join(scratch, 'claude', 'settings.json');
  const geminiSettings = join(scratch, 'gemini', 'settings.json');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(dirname(claudeSettings), { recursive: true });
  mkdirSync(dirname(geminiSettings), { recursive: true });
  for (const name of ['claude', 'gemini']) {
    const fake = join(fakeBin, name);
    writeFileSync(fake, `#!/bin/sh\nprintf '${name} 99.0.0\\n'\n`);
    chmodSync(fake, 0o755);
  }
  writeFileSync(claudeSettings, JSON.stringify({ theme: 'dark' }));
  writeFileSync(geminiSettings, JSON.stringify({ theme: 'dark' }));
  activationEnv = {
    ...isolatedEnv,
    PATH: fakeBin + delimiter + (process.env.PATH ?? ''),
    BLACKBOX_HOME: state,
    BLACKBOX_DB: join(state, 'events.db'),
    BLACKBOX_CLAUDE_SETTINGS: claudeSettings,
    BLACKBOX_GEMINI_SETTINGS: geminiSettings,
  };

  const help = execFileSync(installedBin, ['help'], {
    cwd: scratch,
    encoding: 'utf8',
    env: activationEnv,
  });
  if (!/forensic recorder for AI coding agents/.test(help)) throw new Error('installed CLI help did not run');

  const activationPort = await availableLoopbackPort();
  const durablePrefix = join(scratch, 'durable-prefix');
  activationEnv.BLACKBOX_INSTALL_SPEC = tarball;
  execFileSync(installedBin, ['install', '--prefix', durablePrefix, '--agents', 'claude,gemini', '--local-only-anchor', '--yes', '--no-open', '--port', String(activationPort)], {
    cwd: scratch, env: activationEnv, stdio: 'inherit', timeout: 60_000,
  });
  activated = true;
  const durableRoot = execFileSync(npm, ['root', '--global', '--prefix', durablePrefix], { cwd: scratch, env: activationEnv, encoding: 'utf8' }).trim();
  installedBin = join(durableRoot, 'blackbox-recorder', 'dist', 'cli.js');
  if (!existsSync(installedBin)) throw new Error('one-command installer did not create a durable CLI runtime');
  const geminiHookSettings = readFileSync(geminiSettings, 'utf8');
  if (!geminiHookSettings.includes(installedBin)) throw new Error('Gemini command hooks do not point at the durable CLI');
  let status;
  try {
    status = execFileSync(installedBin, ['status'], { cwd: scratch, env: activationEnv, encoding: 'utf8' });
  } catch (error) {
    const daemonLog = existsSync(join(state, 'daemon.log')) ? readFileSync(join(state, 'daemon.log'), 'utf8') : '(daemon log missing)';
    throw new Error(`packed recorder was not healthy after init:\n${daemonLog}`, { cause: error });
  }
  if (!/daemon: running/.test(status)) throw new Error('packed recorder did not remain healthy after init');
  const doctor = execFileSync(installedBin, ['doctor'], { cwd: scratch, env: activationEnv, encoding: 'utf8' });
  if (!/No failures/.test(doctor)) throw new Error(`packed doctor did not report readiness:\n${doctor}`);
  execFileSync(installedBin, ['self-test'], { cwd: scratch, env: activationEnv, stdio: 'inherit', timeout: 20_000 });
  execFileSync(installedBin, ['verify'], { cwd: scratch, env: activationEnv, stdio: 'inherit' });
  execFileSync(installedBin, ['uninit', '--agents', 'claude,gemini', '--erase-data', '--yes'], {
    cwd: scratch, env: activationEnv, stdio: 'inherit', timeout: 15_000,
  });
  activated = false;
  if (existsSync(state)) throw new Error('uninit left the isolated Blackbox state directory behind');
  for (const settingsPath of [claudeSettings, geminiSettings]) {
    const settings = readFileSync(settingsPath, 'utf8');
    if (!settings.includes('"theme": "dark"')) throw new Error(`uninit did not preserve unrelated settings in ${settingsPath}`);
    if (/blackbox/i.test(settings)) throw new Error(`uninit left Blackbox hooks in ${settingsPath}`);
  }

  const installed = JSON.parse(readFileSync(join(scratch, 'node_modules', 'blackbox-recorder', 'package.json'), 'utf8'));
  if (installed.version !== packed[0].version) throw new Error('installed version does not match packed version');
  process.stdout.write(`packed install OK: ${filename} on Node ${process.versions.node}\n`);
} finally {
  if (activated && installedBin) {
    try { execFileSync(installedBin, ['uninit', '--agents', 'claude,gemini', '--erase-data', '--yes'], { cwd: scratch, env: activationEnv, stdio: 'ignore', timeout: 10_000 }); }
    catch { /* best-effort cleanup after a failed activation assertion */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}
