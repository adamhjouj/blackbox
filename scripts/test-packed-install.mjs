#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'blackbox-packed-install-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const isolatedEnv = { ...process.env, npm_config_cache: join(scratch, 'npm-cache') };

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
  const bin = join(scratch, 'node_modules', '.bin', process.platform === 'win32' ? 'blackbox.cmd' : 'blackbox');
  const help = execFileSync(bin, ['help'], {
    cwd: scratch,
    encoding: 'utf8',
    env: { ...isolatedEnv, BLACKBOX_HOME: join(scratch, 'state'), BLACKBOX_DB: join(scratch, 'state', 'events.db') },
  });
  if (!/forensic recorder for AI coding agents/.test(help)) throw new Error('installed CLI help did not run');

  const installed = JSON.parse(readFileSync(join(scratch, 'node_modules', 'blackbox-recorder', 'package.json'), 'utf8'));
  if (installed.version !== packed[0].version) throw new Error('installed version does not match packed version');
  process.stdout.write(`packed install OK: ${filename} on Node ${process.versions.node}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
