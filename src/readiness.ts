import { createPrivateKey, createPublicKey } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { loadAnchorConfig } from './anchor';
import { launchAgentPath } from './autostart';
import { blackboxDir, configPath, ensureBlackboxDir } from './paths';
import { loadPublicKey, loadWatermark } from './sign';
import type { Store } from './store';
import { verify } from './verify';
import { GEMINI_HOOK_EVENTS } from './adapters/gemini';
import { CODEX_HOOK_EVENTS } from './adapters/codex';
import { GEMINI_HOOK_NAME } from './gemini-init';
import { codexHooksPath, isBlackboxCodexHook } from './codex-init';

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'pending';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  blocking: boolean;
  command?: string;
}

export interface AdapterReadiness {
  id: 'claude-code' | 'gemini-cli' | 'codex-cli';
  label: string;
  installed: boolean;
  connected: boolean;
  detail: string;
}

export interface SetupStatus {
  ready: boolean;
  complete: boolean;
  passed: number;
  total: number;
  first_session: boolean;
  checks: ReadinessCheck[];
  adapters: AdapterReadiness[];
}

interface SelfTestMarker {
  version: 1;
  passed_at: string;
  node: string;
}

const CLAUDE_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Notification',
] as const;

function check(
  id: string,
  label: string,
  status: ReadinessStatus,
  detail: string,
  blocking: boolean,
  command?: string,
): ReadinessCheck {
  return { id, label, status, detail, blocking, ...(command ? { command } : {}) };
}

export function supportedNodeMajor(major: number): boolean {
  return major === 22 || major === 24 || major === 26;
}

function commandOnPath(name: string): boolean {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return paths.some((dir) => suffixes.some((suffix) => {
    try { accessSync(join(dir, name + suffix), constants.X_OK); return true; } catch { return false; }
  }));
}

export function privatePathStatus(path: string): { ok: boolean; detail: string } {
  try {
    const mode = statSync(path).mode & 0o777;
    if (process.platform === 'win32') return { ok: true, detail: 'platform ACLs apply' };
    return mode & 0o077
      ? { ok: false, detail: `permissions are ${mode.toString(8)}; expected no group/other access` }
      : { ok: true, detail: `permissions ${mode.toString(8)}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export function signingIdentityStatus(): { ok: boolean; detail: string } {
  const dir = blackboxDir();
  const privatePath = join(dir, 'signing.key');
  const publicPath = join(dir, 'signing.pub');
  const hasPrivate = existsSync(privatePath);
  const hasPublic = existsSync(publicPath);
  if (hasPrivate !== hasPublic) return { ok: false, detail: 'partial keypair detected; Blackbox will not rotate it automatically' };
  if (!hasPrivate) return { ok: false, detail: 'signing identity has not been created' };
  try {
    const privateKey = createPrivateKey(readFileSync(privatePath, 'utf8'));
    const expected = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const actual = createPublicKey(readFileSync(publicPath, 'utf8')).export({ type: 'spki', format: 'der' });
    if (!expected.equals(actual)) return { ok: false, detail: 'public and private signing keys do not match' };
    const privatePerms = privatePathStatus(privatePath);
    if (!privatePerms.ok) return { ok: false, detail: `private key ${privatePerms.detail}` };
    return { ok: true, detail: 'valid Ed25519 identity; private key is local and protected' };
  } catch (err) {
    return { ok: false, detail: `invalid signing identity: ${(err as Error).message}` };
  }
}

export function claudeAdapterReadiness(port: number): AdapterReadiness {
  const settingsPath = process.env.BLACKBOX_CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
  const installed = commandOnPath('claude');
  if (!existsSync(settingsPath)) return { id: 'claude-code', label: 'Claude Code', installed, connected: false, detail: 'settings file not found' };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, unknown> };
    const expected = `http://127.0.0.1:${port}/hook`;
    const missing = CLAUDE_EVENTS.filter((event) => {
      const groups = parsed.hooks?.[event];
      if (!Array.isArray(groups)) return true;
      return !groups.some((group) => {
        const hooks = group && typeof group === 'object' ? (group as { hooks?: unknown }).hooks : null;
        return Array.isArray(hooks) && hooks.some((hook) => hook && typeof hook === 'object' && (hook as { type?: string }).type === 'http' && (hook as { url?: string }).url === expected);
      });
    });
    return missing.length
      ? { id: 'claude-code', label: 'Claude Code', installed, connected: false, detail: `${missing.length} required hook${missing.length === 1 ? '' : 's'} missing or pointed at another port` }
      : { id: 'claude-code', label: 'Claude Code', installed, connected: installed, detail: installed ? `all ${CLAUDE_EVENTS.length} hooks target port ${port}` : 'hooks are configured but `claude` is not on PATH' };
  } catch {
    return { id: 'claude-code', label: 'Claude Code', installed, connected: false, detail: 'settings JSON is malformed' };
  }
}

export function geminiAdapterReadiness(): AdapterReadiness {
  const settingsPath = process.env.BLACKBOX_GEMINI_SETTINGS ?? join(homedir(), '.gemini', 'settings.json');
  const installed = commandOnPath('gemini');
  if (!existsSync(settingsPath)) return { id: 'gemini-cli', label: 'Gemini CLI', installed, connected: false, detail: 'settings file not found' };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, unknown> };
    const missing = GEMINI_HOOK_EVENTS.filter((event) => {
      const groups = parsed.hooks?.[event];
      if (!Array.isArray(groups)) return true;
      return !groups.some((group) => {
        const hooks = group && typeof group === 'object' ? (group as { hooks?: unknown }).hooks : null;
        return Array.isArray(hooks) && hooks.some((hook) => hook && typeof hook === 'object' &&
          (hook as { name?: string }).name === GEMINI_HOOK_NAME &&
          typeof (hook as { command?: unknown }).command === 'string' &&
          /\bhook\s+gemini\b/.test((hook as { command: string }).command));
      });
    });
    return missing.length
      ? { id: 'gemini-cli', label: 'Gemini CLI', installed, connected: false, detail: `${missing.length} required command hook${missing.length === 1 ? '' : 's'} missing` }
      : { id: 'gemini-cli', label: 'Gemini CLI', installed, connected: installed, detail: installed ? `all ${GEMINI_HOOK_EVENTS.length} hooks connected` : 'hooks are configured but `gemini` is not on PATH' };
  } catch {
    return { id: 'gemini-cli', label: 'Gemini CLI', installed, connected: false, detail: 'settings JSON is malformed' };
  }
}

export function codexAdapterReadiness(): AdapterReadiness {
  const hooksPath = codexHooksPath();
  const installed = commandOnPath('codex');
  if (!existsSync(hooksPath)) return { id: 'codex-cli', label: 'Codex CLI', installed, connected: false, detail: 'hooks file not found' };
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as { hooks?: Record<string, unknown> };
    const missing = CODEX_HOOK_EVENTS.filter((event) => {
      const groups = parsed.hooks?.[event];
      if (!Array.isArray(groups)) return true;
      return !groups.some((group) => {
        const hooks = group && typeof group === 'object' ? (group as { hooks?: unknown }).hooks : null;
        return Array.isArray(hooks) && hooks.some(isBlackboxCodexHook);
      });
    });
    return missing.length
      ? { id: 'codex-cli', label: 'Codex CLI', installed, connected: false, detail: `${missing.length} required lifecycle hook${missing.length === 1 ? '' : 's'} missing` }
      : { id: 'codex-cli', label: 'Codex CLI', installed, connected: installed, detail: installed ? `all ${CODEX_HOOK_EVENTS.length} hooks configured; Codex trust is managed with /hooks` : 'hooks are configured but `codex` is not on PATH' };
  } catch {
    return { id: 'codex-cli', label: 'Codex CLI', installed, connected: false, detail: 'hooks JSON is malformed' };
  }
}

export function selfTestMarkerPath(): string {
  return join(blackboxDir(), 'self-test.json');
}

export function recordSelfTestPass(at: string = new Date().toISOString()): void {
  const dir = ensureBlackboxDir();
  const path = join(dir, 'self-test.json');
  const temporary = join(dir, `.self-test.${process.pid}.tmp`);
  const marker: SelfTestMarker = { version: 1, passed_at: at, node: process.version };
  writeFileSync(temporary, JSON.stringify(marker, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* best effort on non-POSIX */ }
}

export function readSelfTestMarker(): SelfTestMarker | null {
  try {
    const path = selfTestMarkerPath();
    if (lstatSync(path).isSymbolicLink()) return null;
    const marker = JSON.parse(readFileSync(path, 'utf8')) as Partial<SelfTestMarker>;
    return marker.version === 1 && typeof marker.passed_at === 'string' && typeof marker.node === 'string'
      ? (marker as SelfTestMarker)
      : null;
  } catch {
    return null;
  }
}

export function buildSetupStatus(store: Store, opts: { db: string; port: number }): SetupStatus {
  const checks: ReadinessCheck[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    supportedNodeMajor(major)
      ? check('runtime', 'Supported Node.js', 'pass', `${process.version} is supported`, true)
      : check('runtime', 'Supported Node.js', 'fail', `${process.version} is unsupported; use Node 22, 24, or 26`, true),
  );

  const state = blackboxDir();
  try {
    accessSync(state, constants.R_OK | constants.W_OK);
    const mode = privatePathStatus(state);
    checks.push(mode.ok
      ? check('state', 'Private local state', 'pass', `${state} is writable with ${mode.detail}`, true)
      : check('state', 'Private local state', 'fail', `${state}: ${mode.detail}`, true, 'chmod 700 ~/.blackbox'));
  } catch (err) {
    checks.push(check('state', 'Private local state', 'fail', `${state}: ${(err as Error).message}`, true, 'blackbox init'));
  }

  const signing = signingIdentityStatus();
  checks.push(signing.ok
    ? check('signing', 'Signing identity', 'pass', signing.detail, true)
    : check('signing', 'Signing identity', 'fail', signing.detail, true, 'blackbox doctor'));

  const adapters = [claudeAdapterReadiness(opts.port), geminiAdapterReadiness(), codexAdapterReadiness()];
  const connected = adapters.filter((adapter) => adapter.connected);
  checks.push(connected.length
    ? check('adapter', 'Agent adapter connected', 'pass', connected.map((adapter) => adapter.label).join(', '), true)
    : check('adapter', 'Agent adapter connected', 'fail', 'no complete Claude Code, Gemini CLI, or Codex CLI adapter is configured', true, 'blackbox init'));

  checks.push(check('daemon', 'Recorder health', 'pass', `healthy on loopback port ${opts.port}`, true));

  let integrity;
  try {
    integrity = verify(store, { trustedPublicKey: loadPublicKey(), watermark: loadWatermark() });
    const dbMode = privatePathStatus(opts.db);
    const writable = (() => { try { accessSync(opts.db, constants.R_OK | constants.W_OK); return true; } catch { return false; } })();
    checks.push(integrity.ok && writable && dbMode.ok
      ? check('store', 'Writable verified store', 'pass', `${integrity.count} chained rows; ${dbMode.detail}`, true)
      : check('store', 'Writable verified store', 'fail', !integrity.ok ? integrity.break?.detail ?? 'chain verification failed' : !writable ? `${opts.db} is not writable` : `${opts.db}: ${dbMode.detail}`, true, 'blackbox doctor'));
  } catch (err) {
    checks.push(check('store', 'Writable verified store', 'fail', (err as Error).message, true, 'blackbox doctor'));
  }

  try {
    const anchor = loadAnchorConfig();
    checks.push(anchor.target && !anchor.localOnly
      ? check('custody', 'Custody configured', 'pass', `${anchor.target.kind} receipt destination configured`, false)
      : anchor.localOnly
        ? check('custody', 'Custody configured', 'warn', 'local-only receipts; reduced tamper resistance', false, 'blackbox anchor --to <target>')
        : check('custody', 'Custody configured', 'fail', 'no receipt destination configured', true, 'blackbox anchor --to <target>'));
  } catch (err) {
    checks.push(check('custody', 'Custody configured', 'fail', (err as Error).message, true, 'blackbox doctor'));
  }

  const marker = readSelfTestMarker();
  checks.push(marker
    ? check('self-test', 'Capture self-test', 'pass', `passed ${marker.passed_at} on ${marker.node}`, true)
    : check('self-test', 'Capture self-test', 'pending', 'not run for this installation', true, 'blackbox self-test'));

  const firstSession = store.eventsLight().some((event) => !event.session_id.startsWith('bb:'));
  checks.push(firstSession
    ? check('first-session', 'First agent session', 'pass', 'real agent evidence has been received', false)
    : check('first-session', 'First agent session', 'pending', 'waiting for the first connected agent session', false));

  if (process.platform === 'darwin') {
    checks.push(existsSync(launchAgentPath())
      ? check('autostart', 'Start at login', 'pass', 'LaunchAgent installed', false)
      : check('autostart', 'Start at login', 'warn', 'recommended so recording survives restarts', false, 'blackbox autostart'));
  } else {
    checks.push(check('autostart', 'Start at login', 'warn', 'not managed automatically on this platform', false));
  }

  // Config is deliberately not returned by this API. This check merely confirms
  // the authenticated git collector can start without exposing its token.
  try {
    const config = JSON.parse(readFileSync(configPath(), 'utf8')) as { token?: string };
    if (!config.token || config.token.length < 16) checks.push(check('collector-auth', 'Collector authentication', 'fail', 'collector token is missing', true, 'blackbox init'));
    else checks.push(check('collector-auth', 'Collector authentication', 'pass', 'local git writes require authentication', true));
  } catch {
    checks.push(check('collector-auth', 'Collector authentication', 'fail', 'secure configuration could not be read', true, 'blackbox doctor'));
  }

  const ready = checks.every((item) => !item.blocking || item.status === 'pass');
  return {
    ready,
    complete: ready && firstSession,
    passed: checks.filter((item) => item.status === 'pass').length,
    total: checks.length,
    first_session: firstSession,
    checks,
    adapters,
  };
}
