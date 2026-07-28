import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { anchorDisplayDestination, loadAnchorConfig } from './anchor';
import { readConfig } from './config';
import { blackboxDir, configPath } from './paths';
import { claudeAdapterReadiness, codexAdapterReadiness, geminiAdapterReadiness, privatePathStatus, signingIdentityStatus, supportedNodeMajor } from './readiness';

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

export function staticDoctorChecks(dbPath: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    supportedNodeMajor(major)
      ? check('Node.js', 'pass', `${process.version} (supported: 22, 24, 26)`)
      : check('Node.js', 'fail', `${process.version} is unsupported; use Node 22, 24, or 26`),
  );

  let config: Record<string, unknown> = {};
  let configError: string | null = null;
  try { config = readConfig(configPath()); }
  catch (err) { configError = (err as Error).message; }
  const configuredPort = typeof config.port === 'number' && Number.isInteger(config.port) ? config.port : 7842;

  const claude = readableVersion('claude', ['--version']);
  const claudeHooks = claudeAdapterReadiness(configuredPort);
  checks.push(
    claude && claudeHooks.connected
      ? check('Claude Code', 'pass', `${claude}; ${claudeHooks.detail}`)
      : check('Claude Code', 'warn', claude ? `${claude}; ${claudeHooks.detail}` : '`claude` was not found on PATH'),
  );
  const gemini = readableVersion('gemini', ['--version']);
  const geminiHooks = geminiAdapterReadiness();
  checks.push(
    gemini && geminiHooks.connected
      ? check('Gemini CLI', 'pass', `${gemini}; ${geminiHooks.detail}`)
      : check('Gemini CLI', 'warn', gemini ? `${gemini}; ${geminiHooks.detail}` : '`gemini` was not found on PATH'),
  );
  const codex = readableVersion('codex', ['--version']);
  const codexHooks = codexAdapterReadiness();
  checks.push(
    codex && codexHooks.connected
      ? check('Codex CLI', 'pass', `${codex}; ${codexHooks.detail}`)
      : check('Codex CLI', 'warn', codex ? `${codex}; ${codexHooks.detail}` : '`codex` was not found on PATH'),
  );
  const completeAdapters = [!!claude && claudeHooks.connected, !!gemini && geminiHooks.connected, !!codex && codexHooks.connected].filter(Boolean).length;
  checks.push(
    completeAdapters
      ? check('Agent adapters', 'pass', `${completeAdapters} complete adapter${completeAdapters === 1 ? '' : 's'}`)
      : check('Agent adapters', 'fail', 'no installed agent has a complete Blackbox hook configuration'),
  );

  const state = blackboxDir();
  if (!existsSync(state)) {
    checks.push(check('State directory', 'warn', `${state} does not exist yet; run blackbox init`));
  } else {
    try {
      accessSync(state, constants.R_OK | constants.W_OK);
      const privacy = privatePathStatus(state);
      checks.push(privacy.ok
        ? check('State directory', 'pass', `${state} is readable, writable, and private (${privacy.detail})`)
        : check('State directory', 'fail', `${state}: ${privacy.detail}`));
    } catch {
      checks.push(check('State directory', 'fail', `${state} is not readable and writable`));
    }
  }

  const signing = signingIdentityStatus();
  checks.push(
    signing.ok
      ? check('Signing identity', 'pass', signing.detail)
      : check('Signing identity', 'fail', signing.detail),
  );

  const token = typeof config.token === 'string' ? config.token : '';
  checks.push(
    configError
      ? check('Git collector auth', 'fail', configError)
      : token.length >= 16
      ? check('Git collector auth', 'pass', 'loopback /git writes require a token')
      : check('Git collector auth', 'fail', 'missing collector token; run blackbox init'),
  );

  try {
    const anchor = loadAnchorConfig();
    if (anchor.target) {
      checks.push(check('Custody anchor', anchor.localOnly ? 'warn' : 'pass', `${anchorDisplayDestination(anchor.target)}${anchor.push ? ' (auto-push)' : ''}${anchor.localOnly ? ' (local-only)' : ''}`));
    } else if (anchor.localOnly) {
      checks.push(check('Custody anchor', 'warn', 'local-only; full home-directory access can rewrite custody'));
    } else {
      checks.push(check('Custody anchor', 'fail', 'no anchor configured'));
    }
  } catch (err) {
    checks.push(check('Custody anchor', 'fail', (err as Error).message));
  }

  if (!existsSync(dbPath)) {
    checks.push(check('Event store', 'warn', `${dbPath} does not exist yet`));
  } else {
    try {
      const bytes = statSync(dbPath).size;
      const privacy = privatePathStatus(dbPath);
      checks.push(privacy.ok
        ? check('Event store', 'pass', `${dbPath} (${formatBytes(bytes)}, ${privacy.detail})`)
        : check('Event store', 'fail', `${dbPath}: ${privacy.detail}`));
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
