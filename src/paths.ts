import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of blackbox's local state. Override with $BLACKBOX_HOME (used in tests). */
export function blackboxDir(): string {
  return process.env.BLACKBOX_HOME ?? join(homedir(), '.blackbox');
}

export function ensureBlackboxDir(): string {
  const dir = blackboxDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function defaultDbPath(): string {
  return join(blackboxDir(), 'blackbox.db');
}

/**
 * Resolve the store path: explicit --db flag > $BLACKBOX_DB > ~/.blackbox/blackbox.db.
 * Creates ~/.blackbox only when the default is actually used.
 */
export function resolveDb(flag?: string): string {
  if (flag) return flag;
  if (process.env.BLACKBOX_DB) return process.env.BLACKBOX_DB;
  ensureBlackboxDir();
  return defaultDbPath();
}

export const pidPath = () => join(blackboxDir(), 'daemon.pid');
export const logPath = () => join(blackboxDir(), 'daemon.log');
export const configPath = () => join(blackboxDir(), 'config.json');
