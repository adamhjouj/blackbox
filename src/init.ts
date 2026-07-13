import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { blackboxDir, configPath, ensureBlackboxDir } from './paths';
import { ensureKeypair } from './sign';
import { loadAnchorConfig, resolveDefaultAnchor, type AnchorTarget } from './anchor';

/** Tool events get a "*" matcher; the rest are matcher-less groups. */
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
// PreCompact + Notification make context-compaction and permission/idle prompts
// visible facts: compaction explains a mid-session behavior shift, and a
// permission Notification before a dangerous action is forensic signal.
const OTHER_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Notification'];

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

/** One blackbox hook handler. `timeout` is in SECONDS (Claude Code's unit) and
 *  `async: true` keeps the hook off the agent's critical path. */
function blackboxHandler(port: number): HookHandler {
  return { type: 'http', url: hookUrl(port), async: true, timeout: 5 };
}

/**
 * The blackbox hook block, keyed by event — pure, no filesystem. Tool events get
 * a "*" matcher (to catch every tool, MCP included); the rest are matcher-less.
 * Single source of truth for what `init` writes and what the tests assert.
 */
export function buildHookConfig(port: number): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {};
  for (const event of TOOL_EVENTS) out[event] = [{ matcher: '*', hooks: [blackboxHandler(port)] }];
  for (const event of OTHER_EVENTS) out[event] = [{ hooks: [blackboxHandler(port)] }];
  return out;
}

/**
 * Merge the blackbox hook block into an existing settings object — pure (returns
 * a new object, touches no disk) and idempotent: an event that already carries a
 * blackbox http hook is left untouched, so merging twice equals merging once and
 * pre-existing user hooks are never clobbered.
 */
export function mergeHooks(existing: Settings, port: number): { settings: Settings; addedEvents: string[] } {
  const hooks: Record<string, HookGroup[]> = { ...(existing.hooks ?? {}) };
  const added: string[] = [];
  for (const [event, groups] of Object.entries(buildHookConfig(port))) {
    const cur = hooks[event];
    const current = Array.isArray(cur) ? cur : [];
    if (current.some((g) => g.hooks?.some(isBlackboxHttpHook))) {
      hooks[event] = current;
      continue;
    }
    hooks[event] = [...current, ...groups];
    added.push(event);
  }
  return { settings: { ...existing, hooks }, addedEvents: added };
}

/** Merge blackbox http hooks into ~/.claude/settings.json, idempotently, never clobbering. */
export function init(port: number): { settingsPath: string; addedEvents: string[]; token: string } {
  const path = claudeSettingsPath();
  const { settings, addedEvents } = mergeHooks(readSettings(path), port);
  writeSettings(path, settings);
  const token = ensureConfig(port);
  // R3: generate the chain-of-custody signing keypair (once, idempotent). Best-effort
  // — a keygen failure must never block recording setup.
  try {
    ensureKeypair();
  } catch {
    /* signing simply stays off until a key exists */
  }
  return { settingsPath: path, addedEvents, token };
}

export type InitAnchorDecision =
  | { ok: true; kind: 'existing'; target: AnchorTarget }
  | { ok: true; kind: 'git'; spec: string; remote: string }
  | { ok: true; kind: 'local-only'; path: string }
  | { ok: false; message: string };

/**
 * Decide the external-anchor custody posture for `blackbox init`. External anchoring
 * is REQUIRED by default: a signed head receipt placed off-machine, so a process with
 * full ~/.blackbox write access can't rewrite history and re-sign it undetectably.
 * Order of resolution:
 *   1. an anchor already configured → keep it;
 *   2. explicit `--local-only-anchor` → the acknowledged reduced-security fallback;
 *   3. else auto-resolve a git receipt anchor from a repo (with a remote) at `cwd`;
 *   4. else FAIL LOUDLY — never silently run with no off-machine custody.
 * Pure: reads config + runs `git`, writes nothing. The CLI applies the result.
 */
export function decideInitAnchor(opts: { cwd: string; localOnly?: boolean; cfgPath?: string }): InitAnchorDecision {
  const existing = loadAnchorConfig(opts.cfgPath).target;
  if (existing) return { ok: true, kind: 'existing', target: existing };
  if (opts.localOnly) return { ok: true, kind: 'local-only', path: join(blackboxDir(), 'anchors.jsonl') };
  const resolved = resolveDefaultAnchor(opts.cwd);
  if (resolved) return { ok: true, kind: 'git', spec: resolved.spec, remote: resolved.remote };
  return {
    ok: false,
    message:
      'refusing to finish setup: no external anchor target could be resolved.\n\n' +
      'External anchoring places a signed head receipt OFF this machine, so a process\n' +
      'with full ~/.blackbox write access cannot rewrite history and re-sign it\n' +
      'undetectably. It is required by default. Fix it one of these ways:\n' +
      '  • run `blackbox init` from a git repo that has a remote (receipts push there), or\n' +
      '  • set a target explicitly:\n' +
      '      blackbox anchor --to git:<repo>          (push receipts to that repo’s remote)\n' +
      '      blackbox anchor --to file:</other/disk>  (a second disk / synced folder)\n' +
      '      blackbox anchor --to https://<url>       (a receipt endpoint), or\n' +
      '  • accept the reduced-security local-only posture EXPLICITLY:\n' +
      '      blackbox init --local-only-anchor\n',
  };
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

/** Ensure ~/.blackbox/config.json has a /git auth token (generated once if absent,
 *  never rotated) and update the port. Returns the token. The daemon REQUIRES this
 *  token on the /git route by default, so provisioning it here keeps "secure by
 *  default" from becoming a setup-failure mode. */
export function ensureConfig(port: number): string {
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
