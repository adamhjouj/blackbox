import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configPath, ensureBlackboxDir } from './paths';

/** Tool events get a "*" matcher; the rest are matcher-less groups. */
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const OTHER_EVENTS = ['SessionStart', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'];

const MIN_VERSION = [2, 1, 119]; // duration_ms floor

function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hook`;
}

/** Our http hooks all match this shape; used for idempotency + uninit. */
function isBlackboxHttpHook(h: unknown): boolean {
  return (
    !!h &&
    typeof h === 'object' &&
    (h as { type?: string }).type === 'http' &&
    /^http:\/\/127\.0\.0\.1:\d+\/hook$/.test((h as { url?: string }).url ?? '')
  );
}

interface HookHandler {
  type: string;
  url?: string;
  async?: boolean;
  timeout?: number;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch {
    throw new Error(`could not parse ${path} as JSON — refusing to modify it`);
  }
}

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, path + '.blackbox-bak');
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

/** Merge blackbox http hooks into ~/.claude/settings.json, idempotently, never clobbering. */
export function init(port: number): { settingsPath: string; addedEvents: string[]; token: string } {
  const path = claudeSettingsPath();
  const settings = readSettings(path);
  settings.hooks ??= {};
  const url = hookUrl(port);
  const added: string[] = [];

  for (const event of [...TOOL_EVENTS, ...OTHER_EVENTS]) {
    const groups = (settings.hooks[event] ??= []);
    const already = groups.some((g) => g.hooks?.some(isBlackboxHttpHook));
    if (already) continue;
    const handler: HookHandler = { type: 'http', url, async: true, timeout: 5 };
    groups.push(TOOL_EVENTS.includes(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] });
    added.push(event);
  }

  writeSettings(path, settings);
  const token = ensureConfig(port);
  return { settingsPath: path, addedEvents: added, token };
}

/** Remove blackbox http hooks; leave every other hook untouched. */
export function uninit(): { settingsPath: string; removed: number } {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return { settingsPath: path, removed: 0 };
  const settings = readSettings(path);
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept: HookGroup[] = [];
    for (const g of groups) {
      const before = g.hooks?.length ?? 0;
      g.hooks = (g.hooks ?? []).filter((h) => !isBlackboxHttpHook(h));
      removed += before - g.hooks.length;
      if (g.hooks.length) kept.push(g);
    }
    if (kept.length) settings.hooks![event] = kept;
    else delete settings.hooks![event];
  }
  writeSettings(path, settings);
  return { settingsPath: path, removed };
}

/** Ensure ~/.blackbox/config.json has a token; update the port. Returns the token. */
function ensureConfig(port: number): string {
  ensureBlackboxDir();
  const path = configPath();
  let cfg: { token?: string; port?: number } = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8')) as typeof cfg;
    } catch {
      cfg = {};
    }
  }
  cfg.token ??= randomBytes(16).toString('hex');
  cfg.port = port;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return cfg.token;
}

/** Best-effort Claude Code version check. Returns a warning string, or null if fine/unknown. */
export function versionWarning(): string | null {
  let out: string;
  try {
    out = execFileSync('claude', ['--version'], { encoding: 'utf8' });
  } catch {
    return 'could not run `claude --version` — is Claude Code installed and on PATH?';
  }
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i]! > MIN_VERSION[i]!) return null;
    if (v[i]! < MIN_VERSION[i]!)
      return `Claude Code ${m[0]} is older than ${MIN_VERSION.join('.')}; some fields (duration_ms) may be missing.`;
  }
  return null;
}
