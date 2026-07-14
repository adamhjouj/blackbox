import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadAnchorConfig } from './anchor';
import { blackboxDir, configPath } from './paths';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

function check(name: string, status: DoctorStatus, detail: string): DoctorCheck {
  return { name, status, detail };
}

function readableVersion(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 3_000 }).trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

function hasBlackboxHook(settingsPath: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, unknown> };
    return /http:\/\/127\.0\.0\.1:\d+\/hook/.test(JSON.stringify(settings.hooks ?? {}));
  } catch {
    return false;
  }
}

export function staticDoctorChecks(dbPath: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    major >= 18 && major < 23
      ? check('Node.js', 'pass', `${process.version} (supported: 18, 20, 22)`)
      : check('Node.js', 'fail', `${process.version} is unsupported; use Node 18, 20, or 22`),
  );

  const claude = readableVersion('claude', ['--version']);
  checks.push(
    claude
      ? check('Claude Code', 'pass', claude)
      : check('Claude Code', 'fail', '`claude` was not found on PATH'),
  );

  const state = blackboxDir();
  if (!existsSync(state)) {
    checks.push(check('State directory', 'warn', `${state} does not exist yet; run blackbox init`));
  } else {
    try {
      accessSync(state, constants.R_OK | constants.W_OK);
      checks.push(check('State directory', 'pass', `${state} is readable and writable`));
    } catch {
      checks.push(check('State directory', 'fail', `${state} is not readable and writable`));
    }
  }

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  checks.push(
    hasBlackboxHook(settingsPath)
      ? check('Claude hooks', 'pass', `registered in ${settingsPath}`)
      : check('Claude hooks', 'fail', `no Blackbox hook found in ${settingsPath}`),
  );

  let token = '';
  try {
    token = (JSON.parse(readFileSync(configPath(), 'utf8')) as { token?: string }).token ?? '';
  } catch {
    /* reported below */
  }
  checks.push(
    token.length >= 16
      ? check('Git collector auth', 'pass', 'loopback /git writes require a token')
      : check('Git collector auth', 'fail', 'missing collector token; run blackbox init'),
  );

  const anchor = loadAnchorConfig();
  if (anchor.target) {
    const destination =
      anchor.target.kind === 'git'
        ? `git:${anchor.target.repo}${anchor.push ? ' (auto-push)' : ''}`
        : anchor.target.kind === 'file'
          ? `file:${anchor.target.path}`
          : anchor.target.url;
    checks.push(check('Custody anchor', 'pass', destination));
  } else if (anchor.localOnly) {
    checks.push(check('Custody anchor', 'warn', 'local-only; full home-directory access can rewrite custody'));
  } else {
    checks.push(check('Custody anchor', 'fail', 'no anchor configured'));
  }

  if (!existsSync(dbPath)) {
    checks.push(check('Event store', 'warn', `${dbPath} does not exist yet`));
  } else {
    try {
      const bytes = statSync(dbPath).size;
      checks.push(check('Event store', 'pass', `${dbPath} (${formatBytes(bytes)})`));
    } catch (err) {
      checks.push(check('Event store', 'fail', (err as Error).message));
    }
  }

  const platform = process.platform;
  checks.push(
    platform === 'darwin'
      ? check('Platform', 'pass', 'macOS (full lifecycle and LaunchAgent support)')
      : platform === 'linux'
        ? check('Platform', 'warn', 'Linux recording works; autostart is not yet managed')
        : check('Platform', 'warn', `${platform} is experimental`),
  );
  return checks;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (let i = 1; value >= 1_024 && i < units.length; i++) {
    value /= 1_024;
    unit = units[i]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
