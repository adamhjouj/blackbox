import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { blackboxDir, configPath, ensureBlackboxDir } from './paths';

const MARKER = '>>> blackbox';
const HOOK_NAMES = ['reference-transaction', 'pre-push'] as const;
type HookName = (typeof HOOK_NAMES)[number];

interface Config {
  token: string;
  port: number;
}
/** Load config, generating+persisting a token if none exists, so installed
 *  git hooks always carry a token that the daemon requires on /git. */
function loadConfig(): Config {
  let c: Record<string, unknown> = {};
  try {
    c = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    /* no config yet */
  }
  if (typeof c.token !== 'string' || !c.token) {
    ensureBlackboxDir();
    c = { ...c, token: randomBytes(16).toString('hex'), port: (c.port as number) ?? 7842 };
    writeFileSync(configPath(), JSON.stringify(c, null, 2) + '\n');
  }
  return { token: c.token as string, port: (c.port as number) ?? 7842 };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function hooksDirOf(repo: string): string {
  const hp = git(repo, ['rev-parse', '--git-path', 'hooks']);
  return isAbsolute(hp) ? hp : join(repo, hp);
}

/** The capture snippet for one hook, POSTing the ref-delta body to the daemon. */
function captureSnippet(name: HookName, cfg: Config): string {
  const curl = (kind: string, state: string) =>
    `( printf '%s' "$__bb_input" | curl -s --max-time 1 --data-binary @- ` +
    `-H "X-BB-Kind: ${kind}" -H "X-BB-State: ${state}" -H "X-BB-Cwd: $(pwd)" -H "X-BB-Token: ${cfg.token}" ` +
    `"http://127.0.0.1:${cfg.port}/git" >/dev/null 2>&1 & ) >/dev/null 2>&1 || true`;
  if (name === 'reference-transaction') {
    return `if [ "$1" = "committed" ]; then\n  ${curl('ref-transaction', 'committed')}\nfi`;
  }
  return curl('pre-push', 'push'); // pre-push: always capture (intent to push)
}

/** A standalone blackbox hook (no prior hook to chain to). */
function freshHook(name: HookName, cfg: Config): string {
  return `#!/bin/sh
# ${MARKER} (do not edit this block) >>>
__bb_input=$(cat 2>/dev/null || true)
${captureSnippet(name, cfg)}
# <<< blackbox <<<
exit 0
`;
}

/** A wrapper that captures, then delegates to the pre-existing hook, preserving exit code. */
function wrapperHook(name: HookName, cfg: Config): string {
  return `#!/bin/sh
# ${MARKER} tee-wrapper (do not edit this block) >>>
__bb_input=$(cat 2>/dev/null || true)
${captureSnippet(name, cfg)}
__bb_orig="$0.blackbox-orig"
if [ -x "$__bb_orig" ]; then
  printf '%s' "$__bb_input" | "$__bb_orig" "$@"
  exit $?
fi
exit 0
# <<< blackbox <<<
`;
}

function installOne(hooksDir: string, name: HookName, cfg: Config): 'installed' | 'wrapped' | 'already' {
  mkdirSync(hooksDir, { recursive: true });
  const file = join(hooksDir, name);
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8');
    if (current.includes(MARKER)) return 'already';
    // Preserve the user's hook: move it aside and wrap it.
    renameSync(file, file + '.blackbox-orig');
    writeFileSync(file, wrapperHook(name, cfg));
    chmodSync(file, 0o755);
    return 'wrapped';
  }
  writeFileSync(file, freshHook(name, cfg));
  chmodSync(file, 0o755);
  return 'installed';
}

function uninstallOne(hooksDir: string, name: HookName): boolean {
  const file = join(hooksDir, name);
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes(MARKER)) return false;
  const orig = file + '.blackbox-orig';
  if (existsSync(orig)) {
    unlinkSync(file);
    renameSync(orig, file); // restore the user's original
  } else {
    unlinkSync(file);
  }
  return true;
}

export interface WatchResult {
  repoTop: string;
  actions: Record<string, string>;
}

/** Per-repo install (default): touches only this repo, chains to existing hooks. */
export function watchRepo(repoPath: string): WatchResult {
  const repoTop = git(repoPath, ['rev-parse', '--show-toplevel']);
  const hooksDir = hooksDirOf(repoTop);
  const cfg = loadConfig();
  const actions: Record<string, string> = {};
  for (const name of HOOK_NAMES) actions[name] = installOne(hooksDir, name, cfg);
  return { repoTop, actions };
}

export function unwatchRepo(repoPath: string): WatchResult {
  const repoTop = git(repoPath, ['rev-parse', '--show-toplevel']);
  const hooksDir = hooksDirOf(repoTop);
  const actions: Record<string, string> = {};
  for (const name of HOOK_NAMES) actions[name] = uninstallOne(hooksDir, name) ? 'removed' : 'absent';
  return { repoTop, actions };
}

// ---- global (core.hooksPath) opt-in -------------------------------------

function globalHooksDir(): string {
  return join(blackboxDir(), 'git-hooks');
}

/** A global shim: capture, then delegate to whatever git would have run (prior
 *  hooksPath, else the repo's own hook), preserving exit code. */
function globalShim(name: HookName, cfg: Config, priorHooksPath: string): string {
  return `#!/bin/sh
# ${MARKER} global shim (do not edit) >>>
__bb_input=$(cat 2>/dev/null || true)
${captureSnippet(name, cfg)}
__bb_name="${name}"
__bb_prior="${priorHooksPath}"
if [ -n "$__bb_prior" ] && [ -x "$__bb_prior/$__bb_name" ]; then
  printf '%s' "$__bb_input" | "$__bb_prior/$__bb_name" "$@"
  exit $?
fi
__bb_repohook="$(git rev-parse --git-path hooks 2>/dev/null)/$__bb_name"
if [ -x "$__bb_repohook" ]; then
  printf '%s' "$__bb_input" | "$__bb_repohook" "$@"
  exit $?
fi
exit 0
`;
}

export function watchGlobal(): { hooksDir: string; priorHooksPath: string } {
  ensureBlackboxDir();
  let prior = '';
  try {
    prior = execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
  } catch {
    /* unset */
  }
  const dir = globalHooksDir();
  if (prior === dir) prior = ''; // already ours; don't chain to self
  mkdirSync(dir, { recursive: true });
  const cfg = loadConfig();
  for (const name of HOOK_NAMES) {
    const file = join(dir, name);
    writeFileSync(file, globalShim(name, cfg, prior));
    chmodSync(file, 0o755);
  }
  // persist prior so uninstall can restore it — but never overwrite an already-saved
  // real prior with '' (would lose the user's original hooksPath on a second run).
  const cfgPath = configPath();
  const existing = existsSafe(cfgPath) ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>) : {};
  const savedPrior = typeof existing.priorHooksPath === 'string' && existing.priorHooksPath ? existing.priorHooksPath : prior;
  writeFileSync(cfgPath, JSON.stringify({ ...existing, priorHooksPath: savedPrior }, null, 2) + '\n');
  execFileSync('git', ['config', '--global', 'core.hooksPath', dir]);
  return { hooksDir: dir, priorHooksPath: prior };
}

export function unwatchGlobal(): { restored: string | null } {
  let prior: string | null = null;
  try {
    prior = (JSON.parse(readFileSync(configPath(), 'utf8')) as { priorHooksPath?: string }).priorHooksPath ?? '';
  } catch {
    prior = '';
  }
  if (prior) execFileSync('git', ['config', '--global', 'core.hooksPath', prior]);
  else execFileSync('git', ['config', '--global', '--unset', 'core.hooksPath']);
  try {
    rmSync(globalHooksDir(), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  return { restored: prior || null };
}

function existsSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
