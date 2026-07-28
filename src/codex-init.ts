import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { CODEX_HOOK_EVENTS, type CodexHookEvent } from './adapters/codex';
import { writePrivateFileAtomic } from './config';

export interface CodexCommandHook {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
  commandWindows?: string;
  [key: string]: unknown;
}

export interface CodexHookGroup {
  matcher?: string;
  hooks: CodexCommandHook[];
  [key: string]: unknown;
}

export interface CodexHooksFile {
  description?: string;
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

export interface CodexInitOptions {
  nodePath: string;
  cliPath: string;
  hooksPath?: string;
  timeoutSeconds?: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function requireAbsolute(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
}

export function codexHooksPath(home: string = homedir()): string {
  return process.env.BLACKBOX_CODEX_HOOKS ?? join(home, '.codex', 'hooks.json');
}

export function buildCodexHookCommand(nodePath: string, cliPath: string): string {
  requireAbsolute('nodePath', nodePath);
  requireAbsolute('cliPath', cliPath);
  return `${shellQuote(nodePath)} ${shellQuote(cliPath)} hook codex`;
}

export function buildCodexHookConfig(
  nodePath: string,
  cliPath: string,
  timeoutSeconds: number = 3,
): Record<CodexHookEvent, CodexHookGroup[]> {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3) {
    throw new Error('Codex hook timeout must be an integer from 1 to 3 seconds');
  }
  const command = buildCodexHookCommand(nodePath, cliPath);
  const config = {} as Record<CodexHookEvent, CodexHookGroup[]>;
  for (const event of CODEX_HOOK_EVENTS) {
    config[event] = [{ hooks: [{ type: 'command', command, timeout: timeoutSeconds }] }];
  }
  return config;
}

function cloneHooksFile(file: CodexHooksFile): CodexHooksFile {
  return JSON.parse(JSON.stringify(file)) as CodexHooksFile;
}

export function isBlackboxCodexHook(hook: unknown): boolean {
  return !!hook && typeof hook === 'object' &&
    (hook as { type?: unknown }).type === 'command' &&
    typeof (hook as { command?: unknown }).command === 'string' &&
    /(?:^|\s)hook\s+codex(?:\s|$)/.test((hook as { command: string }).command);
}

/** Pure, idempotent merge that preserves all non-Blackbox hook configuration. */
export function mergeCodexHooks(
  existing: CodexHooksFile,
  nodePath: string,
  cliPath: string,
  timeoutSeconds: number = 3,
): { file: CodexHooksFile; addedEvents: CodexHookEvent[]; updatedEvents: CodexHookEvent[] } {
  const file = cloneHooksFile(existing);
  const hooks: Record<string, CodexHookGroup[]> = { ...(file.hooks ?? {}) };
  const desired = buildCodexHookConfig(nodePath, cliPath, timeoutSeconds);
  const addedEvents: CodexHookEvent[] = [];
  const updatedEvents: CodexHookEvent[] = [];

  for (const event of CODEX_HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event]! : [];
    let found = false;
    let changed = false;
    const next = current.map((group) => {
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      const mapped = handlers.map((handler) => {
        if (!isBlackboxCodexHook(handler)) return handler;
        found = true;
        const replacement = desired[event][0]!.hooks[0]!;
        const refreshed = { ...handler, ...replacement };
        if (JSON.stringify(refreshed) !== JSON.stringify(handler)) changed = true;
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
  file.hooks = hooks;
  return { file, addedEvents, updatedEvents };
}

export function removeCodexHooks(existing: CodexHooksFile): { file: CodexHooksFile; removed: number } {
  const file = cloneHooksFile(existing);
  let removed = 0;
  const hooks = file.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept: CodexHookGroup[] = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const before = Array.isArray(group.hooks) ? group.hooks : [];
      const after = before.filter((handler) => !isBlackboxCodexHook(handler));
      removed += before.length - after.length;
      if (after.length) kept.push({ ...group, hooks: after });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete file.hooks;
  return { file, removed };
}

export function readCodexHooks(path: string): CodexHooksFile {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`could not parse ${path} as JSON — refusing to modify it`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object — refusing to modify it`);
  }
  return parsed as CodexHooksFile;
}

function nextBackupPath(path: string): string {
  const first = `${path}.blackbox-bak`;
  if (!existsSync(first)) return first;
  let n = 2;
  while (existsSync(`${first}.${n}`)) n++;
  return `${first}.${n}`;
}

export function writeCodexHooks(path: string, file: CodexHooksFile): string | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = nextBackupPath(path);
    writePrivateFileAtomic(backupPath, readFileSync(path, 'utf8'), { overwrite: false });
  }
  writePrivateFileAtomic(path, JSON.stringify(file, null, 2) + '\n');
  return backupPath;
}

export function initCodexHooks(opts: CodexInitOptions): {
  hooksPath: string;
  backupPath: string | null;
  addedEvents: CodexHookEvent[];
  updatedEvents: CodexHookEvent[];
} {
  const path = opts.hooksPath ?? codexHooksPath();
  const existing = readCodexHooks(path);
  const merged = mergeCodexHooks(existing, opts.nodePath, opts.cliPath, opts.timeoutSeconds);
  const changed = merged.addedEvents.length > 0 || merged.updatedEvents.length > 0;
  const backupPath = changed ? writeCodexHooks(path, merged.file) : null;
  return { hooksPath: path, backupPath, addedEvents: merged.addedEvents, updatedEvents: merged.updatedEvents };
}

export function rollbackCodexInit(result: {
  hooksPath: string;
  backupPath: string | null;
  addedEvents: CodexHookEvent[];
  updatedEvents: CodexHookEvent[];
}): void {
  if (!result.addedEvents.length && !result.updatedEvents.length) return;
  if (result.backupPath) writePrivateFileAtomic(result.hooksPath, readFileSync(result.backupPath, 'utf8'));
  else rmSync(result.hooksPath, { force: true });
}

export function uninitCodexHooks(path: string = codexHooksPath()): {
  hooksPath: string;
  backupPath: string | null;
  removed: number;
} {
  if (!existsSync(path)) return { hooksPath: path, backupPath: null, removed: 0 };
  const result = removeCodexHooks(readCodexHooks(path));
  const backupPath = result.removed ? writeCodexHooks(path, result.file) : null;
  return { hooksPath: path, backupPath, removed: result.removed };
}
