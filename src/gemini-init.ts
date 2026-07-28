import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { GEMINI_HOOK_EVENTS, type GeminiHookEvent } from './adapters/gemini';
import { writePrivateFileAtomic } from './config';

export const GEMINI_HOOK_NAME = 'blackbox-recorder';

export interface GeminiCommandHook {
  type: 'command';
  name?: string;
  command: string;
  timeout?: number;
  description?: string;
  [key: string]: unknown;
}

export interface GeminiHookGroup {
  matcher?: string;
  sequential?: boolean;
  hooks: GeminiCommandHook[];
  [key: string]: unknown;
}

export interface GeminiSettings {
  hooks?: Record<string, GeminiHookGroup[]>;
  [key: string]: unknown;
}

export interface GeminiInitOptions {
  nodePath: string;
  cliPath: string;
  settingsPath?: string;
  timeoutMs?: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function requireAbsolute(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
}

export function geminiSettingsPath(home: string = homedir()): string {
  return process.env.BLACKBOX_GEMINI_SETTINGS ?? join(home, '.gemini', 'settings.json');
}

export function buildGeminiHookCommand(nodePath: string, cliPath: string): string {
  requireAbsolute('nodePath', nodePath);
  requireAbsolute('cliPath', cliPath);
  return `${shellQuote(nodePath)} ${shellQuote(cliPath)} hook gemini`;
}

/** Pure settings block for all supported Gemini lifecycle and tool hooks. Gemini
 * timeout values are milliseconds; commands are named for /hooks management. */
export function buildGeminiHookConfig(
  nodePath: string,
  cliPath: string,
  timeoutMs: number = 1500,
): Record<GeminiHookEvent, GeminiHookGroup[]> {
  const command = buildGeminiHookCommand(nodePath, cliPath);
  const config = {} as Record<GeminiHookEvent, GeminiHookGroup[]>;
  for (const event of GEMINI_HOOK_EVENTS) {
    const group: GeminiHookGroup = {
      hooks: [
        {
          name: GEMINI_HOOK_NAME,
          type: 'command',
          command,
          timeout: timeoutMs,
          description: 'Record this Gemini CLI event in the local Blackbox evidence chain',
        },
      ],
    };
    if (event === 'BeforeTool' || event === 'AfterTool') group.matcher = '*';
    config[event] = [group];
  }
  return config;
}

function cloneSettings(settings: GeminiSettings): GeminiSettings {
  return JSON.parse(JSON.stringify(settings)) as GeminiSettings;
}

function isBlackboxHook(hook: unknown): boolean {
  return !!hook && typeof hook === 'object' && (hook as { name?: unknown }).name === GEMINI_HOOK_NAME;
}

/** Pure, idempotent merge. Existing Blackbox handlers are refreshed to the
 * current absolute command while all unrelated settings/groups remain intact. */
export function mergeGeminiHooks(
  existing: GeminiSettings,
  nodePath: string,
  cliPath: string,
  timeoutMs: number = 1500,
): { settings: GeminiSettings; addedEvents: GeminiHookEvent[]; updatedEvents: GeminiHookEvent[] } {
  const settings = cloneSettings(existing);
  const hooks: Record<string, GeminiHookGroup[]> = { ...(settings.hooks ?? {}) };
  const desired = buildGeminiHookConfig(nodePath, cliPath, timeoutMs);
  const addedEvents: GeminiHookEvent[] = [];
  const updatedEvents: GeminiHookEvent[] = [];

  for (const event of GEMINI_HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event]! : [];
    let found = false;
    let changed = false;
    const next = current.map((group) => {
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      const mapped = handlers.map((handler) => {
        if (!isBlackboxHook(handler)) return handler;
        found = true;
        const replacement = desired[event][0]!.hooks[0]!;
        const refreshed = { ...handler, ...replacement };
        if (JSON.stringify(handler) !== JSON.stringify(refreshed)) changed = true;
        return refreshed;
      });
      return { ...group, hooks: mapped };
    });

    if (!found) {
      next.push(...desired[event]);
      addedEvents.push(event);
    } else if (changed) {
      updatedEvents.push(event);
    }
    hooks[event] = next;
  }
  settings.hooks = hooks;
  return { settings, addedEvents, updatedEvents };
}

export function removeGeminiHooks(existing: GeminiSettings): { settings: GeminiSettings; removed: number } {
  const settings = cloneSettings(existing);
  let removed = 0;
  const hooks = settings.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept: GeminiHookGroup[] = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const before = Array.isArray(group.hooks) ? group.hooks : [];
      const after = before.filter((handler) => !isBlackboxHook(handler));
      removed += before.length - after.length;
      if (after.length) kept.push({ ...group, hooks: after });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  return { settings, removed };
}

export function readGeminiSettings(path: string): GeminiSettings {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`could not parse ${path} as JSON — refusing to modify it`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object — refusing to modify it`);
  }
  return parsed as GeminiSettings;
}

function nextBackupPath(path: string): string {
  const first = `${path}.blackbox-bak`;
  if (!existsSync(first)) return first;
  let n = 2;
  while (existsSync(`${first}.${n}`)) n++;
  return `${first}.${n}`;
}

/** Atomic settings write with a non-destructive backup of every prior version. */
export function writeGeminiSettings(path: string, settings: GeminiSettings): string | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = nextBackupPath(path);
    writePrivateFileAtomic(backupPath, readFileSync(path, 'utf8'), { overwrite: false });
  }
  writePrivateFileAtomic(path, JSON.stringify(settings, null, 2) + '\n');
  return backupPath;
}

/** Restore the exact pre-init Gemini settings when a later adapter install fails. */
export function rollbackGeminiInit(result: {
  settingsPath: string;
  backupPath: string | null;
  addedEvents: GeminiHookEvent[];
  updatedEvents: GeminiHookEvent[];
}): void {
  if (!result.addedEvents.length && !result.updatedEvents.length) return;
  if (result.backupPath) writePrivateFileAtomic(result.settingsPath, readFileSync(result.backupPath, 'utf8'));
  else rmSync(result.settingsPath, { force: true });
}

export function initGeminiHooks(opts: GeminiInitOptions): {
  settingsPath: string;
  backupPath: string | null;
  addedEvents: GeminiHookEvent[];
  updatedEvents: GeminiHookEvent[];
} {
  const path = opts.settingsPath ?? geminiSettingsPath();
  const existing = readGeminiSettings(path);
  const merged = mergeGeminiHooks(existing, opts.nodePath, opts.cliPath, opts.timeoutMs);
  const changed = merged.addedEvents.length > 0 || merged.updatedEvents.length > 0;
  const backupPath = changed ? writeGeminiSettings(path, merged.settings) : null;
  return { settingsPath: path, backupPath, addedEvents: merged.addedEvents, updatedEvents: merged.updatedEvents };
}

export function uninitGeminiHooks(settingsPath: string = geminiSettingsPath()): {
  settingsPath: string;
  backupPath: string | null;
  removed: number;
} {
  if (!existsSync(settingsPath)) return { settingsPath, backupPath: null, removed: 0 };
  const current = readGeminiSettings(settingsPath);
  const result = removeGeminiHooks(current);
  const backupPath = result.removed ? writeGeminiSettings(settingsPath, result.settings) : null;
  return { settingsPath, backupPath, removed: result.removed };
}
