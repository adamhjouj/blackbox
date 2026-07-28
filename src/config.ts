import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { configPath, ensureBlackboxDir } from './paths';

export type BlackboxConfig = Record<string, unknown>;

/** A malformed config is never treated as an empty config. The original bytes are
 * preserved beside the file so an operator can recover them before repairing it. */
export class MalformedConfigError extends Error {
  constructor(
    public readonly path: string,
    public readonly backupPath: string,
    reason: string,
  ) {
    super(`could not parse ${path} as a JSON object (${reason}); preserved the original at ${backupPath} and refused to continue`);
    this.name = 'MalformedConfigError';
  }
}

function enforceMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (err) {
    // Windows does not implement POSIX permission bits. On supported POSIX hosts,
    // failure to make a secret private is a hard error rather than silent exposure.
    if (process.platform !== 'win32') throw err;
  }
}

/** Write one complete file and publish it atomically. `overwrite:false` uses a hard
 * link as the no-clobber publish primitive, which prevents concurrent key creators
 * from replacing one another after their initial existence check. */
export function writePrivateFileAtomic(path: string, contents: string, opts: { overwrite?: boolean } = {}): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    enforceMode(temp, 0o600);
    if (opts.overwrite === false) {
      linkSync(temp, path);
      rmSync(temp);
    } else {
      renameSync(temp, path);
    }
    enforceMode(path, 0o600);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort cleanup */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best effort cleanup */ }
    throw err;
  }
}

function preserveMalformed(path: string, raw: string): string {
  // Content-address the backup so repeated health/doctor reads of one malformed
  // file do not create an unbounded stream of identical copies.
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const backup = `${path}.malformed-${digest}.bak`;
  if (!existsSync(backup)) {
    try { writePrivateFileAtomic(backup, raw, { overwrite: false }); }
    catch (err) {
      // Another process may have published the identical backup after our check.
      if (!existsSync(backup)) throw err;
    }
  }
  return backup;
}

/** Read config without weakening on corruption. A missing file is the only state
 * that means "fresh config"; malformed JSON and non-object JSON are backed up and
 * then rejected. Existing config permissions are migrated to 0600 on first read. */
export function readConfig(path: string = configPath()): BlackboxConfig {
  if (!existsSync(path)) return {};
  if (path === configPath()) ensureBlackboxDir();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${path}; refusing to continue: ${(err as Error).message}`);
  }
  // Even a malformed file can still contain live tokens. Tighten it before doing
  // anything else, then preserve a second 0600 copy if parsing fails.
  enforceMode(path, 0o600);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value is not an object');
    }
  } catch (err) {
    let backup: string;
    try {
      backup = preserveMalformed(path, raw);
    } catch (backupErr) {
      throw new Error(
        `could not parse ${path} and could not preserve a backup; refusing to continue: ${(backupErr as Error).message}`,
      );
    }
    throw new MalformedConfigError(path, backup, (err as Error).message);
  }
  return parsed as BlackboxConfig;
}

/** Atomically replace config while preserving every caller-owned/unknown field. */
export function writeConfig(config: BlackboxConfig, path: string = configPath()): void {
  if (path === configPath()) ensureBlackboxDir();
  writePrivateFileAtomic(path, JSON.stringify(config, null, 2) + '\n');
}
