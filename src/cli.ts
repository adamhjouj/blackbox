#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { DEFAULT_PORT, startDaemon } from './daemon';
import { init, uninit, versionWarning } from './init';
import { normalize } from './normalize';
import { unwatchGlobal, unwatchRepo, watchGlobal, watchRepo } from './watch';
import { ensureBlackboxDir, logPath, pidPath, resolveDb } from './paths';
import { Store } from './store';
import { verify } from './verify';

interface Args {
  _: string[];
  db?: string;
  session?: string;
  port?: number;
  foreground?: boolean;
  captureOutput?: boolean;
  global?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i] ?? out.db;
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--foreground') out.foreground = true;
    else if (a === '--capture-output') out.captureOutput = true;
    else if (a === '--global') out.global = true;
    else if (a === '-h' || a === '--help') out._.push('help');
    else out._.push(a as string);
  }
  return out;
}

interface PidInfo {
  pid: number;
  port: number;
  db: string;
  started: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readPid(): PidInfo | null {
  try {
    return JSON.parse(readFileSync(pidPath(), 'utf8')) as PidInfo;
  } catch {
    return null;
  }
}
function writePid(info: PidInfo): void {
  ensureBlackboxDir();
  writeFileSync(pidPath(), JSON.stringify(info));
}
function removePid(): void {
  try {
    unlinkSync(pidPath());
  } catch {
    /* already gone */
  }
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Health {
  ok: boolean;
  pid: number;
  port: number;
  uptime_s: number;
  count: number;
  head_seq: number;
  db: string;
}
function getHealth(port: number, timeoutMs = 1000): Promise<Health | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d) as Health);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}
async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await getHealth(port, 500);
    if (h?.ok) return true;
    await sleep(150);
  }
  return false;
}

const HELP = `blackbox — forensic recorder for AI coding agents (Phase 0)

Usage:
  blackbox init                  Register blackbox hooks in ~/.claude/settings.json
  blackbox uninit                Remove blackbox hooks from ~/.claude/settings.json
  blackbox watch [repo]          Install git forensics hooks in a repo (--global for all repos)
  blackbox unwatch [repo]        Remove git forensics hooks (--global to disable global)
  blackbox start                 Start the localhost hook-receiver daemon (background)
  blackbox stop                  Stop the daemon
  blackbox status                Show daemon status
  blackbox ingest <file.jsonl>   Normalize raw hook payloads into the chained store
  blackbox verify                Verify the hash chain; report the first break
  blackbox head                  Print the current head anchor (seq, count, hash)
  blackbox list                  List recorded events (--session <id> to filter)
  blackbox audit                 Show what was redacted (type + path, never the secret)
  blackbox sessions              Summarize recorded sessions

Options:
  --db <path>          Store path (default: $BLACKBOX_DB or ~/.blackbox/blackbox.db)
  --port <n>           Daemon port (default: 7842)
  --foreground         Run the daemon in the foreground (start)
  --capture-output     Store tool output bodies (still redacted) instead of eliding to a hash
  --session <id>       Filter to one session (list/audit)
  -h, --help           Show this help

Exit codes:
  0  success / chain intact
  1  chain broken (verify)
  2  usage / IO error
  3  ingest recorded nothing or skipped malformed lines
`;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cmdIngest(args: Args): number {
  const file = args._[1];
  if (!file) {
    console.error('ingest: missing <file.jsonl>');
    return 2;
  }
  // Read and validate the input BEFORE creating the store, so a bad path never
  // leaves an orphan empty database behind.
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`ingest: cannot read ${file}: ${(err as Error).message}`);
    return 2;
  }

  const capturedAt = new Date().toISOString();
  const store = new Store(resolveDb(args.db));
  let n = 0;
  let firstSeq = 0;
  let lastSeq = 0;
  let skipped = 0;
  let errored = 0;
  try {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        skipped++;
        continue;
      }
      // A recorder must tolerate junk: a non-object payload (null, scalar, array)
      // is not a hook event — skip it rather than crash or store a garbage row.
      if (!isPlainObject(payload)) {
        skipped++;
        continue;
      }
      try {
        const stored = store.append(normalize(payload, capturedAt));
        if (!firstSeq) firstSeq = stored.seq;
        lastSeq = stored.seq;
        n++;
      } catch (err) {
        // One bad record must never abort the run and lose the rest of the file.
        errored++;
        console.error(`ingest: failed to record a line: ${(err as Error).message}`);
      }
    }
  } finally {
    store.close();
  }

  const parts = [`ingested ${n} event(s)`];
  if (n) parts.push(`(seq ${firstSeq}..${lastSeq})`);
  if (skipped) parts.push(`, skipped ${skipped} malformed line(s)`);
  if (errored) parts.push(`, ${errored} record error(s)`);
  console.log(parts.join(' ').replace(' ,', ','));
  return n === 0 || skipped > 0 || errored > 0 ? 3 : 0;
}

function cmdVerify(args: Args): number {
  const store = new Store(resolveDb(args.db));
  const r = verify(store);
  store.close();
  if (r.ok) {
    const anchor = r.anchored ? '' : ' (no head anchor — truncation not checked)';
    console.log(`✓ chain intact — ${r.count} event(s) across ${r.sessions} session(s)${anchor}`);
    return 0;
  }
  const b = r.break!;
  console.error(`✗ chain BROKEN at seq ${b.seq} (${b.reason})`);
  console.error(`  event_id: ${b.event_id}`);
  console.error(`  ${b.detail}`);
  return 1;
}

function cmdHead(args: Args): number {
  const store = new Store(resolveDb(args.db));
  const meta = store.chainMeta();
  store.close();
  if (!meta) {
    console.log('(empty — no events recorded)');
    return 0;
  }
  console.log(`seq ${meta.head_seq}  count ${meta.count}  head ${meta.head_hash}`);
  return 0;
}

function cmdWatch(args: Args): number {
  if (args.global) {
    const r = watchGlobal();
    console.log(`global git watching enabled (core.hooksPath = ${r.hooksDir})`);
    if (r.priorHooksPath) console.log(`  chaining to your prior hooksPath: ${r.priorHooksPath}`);
    return 0;
  }
  const repo = args._[1] ?? process.cwd();
  const r = watchRepo(repo);
  console.log(`watching ${r.repoTop}:`);
  for (const [name, action] of Object.entries(r.actions)) console.log(`  ${name}: ${action}`);
  return 0;
}

function cmdUnwatch(args: Args): number {
  if (args.global) {
    const r = unwatchGlobal();
    console.log(`global git watching disabled${r.restored ? ` (restored hooksPath ${r.restored})` : ''}`);
    return 0;
  }
  const repo = args._[1] ?? process.cwd();
  const r = unwatchRepo(repo);
  console.log(`unwatched ${r.repoTop}:`);
  for (const [name, action] of Object.entries(r.actions)) console.log(`  ${name}: ${action}`);
  return 0;
}

function cmdInit(args: Args): number {
  const port = args.port ?? DEFAULT_PORT;
  const warn = versionWarning();
  if (warn) console.error(`warning: ${warn}`);
  const { settingsPath, addedEvents } = init(port);
  if (addedEvents.length) {
    console.log(`registered blackbox hooks for ${addedEvents.length} event(s) in ${settingsPath}`);
    console.log(`  ${addedEvents.join(', ')}`);
  } else {
    console.log(`blackbox hooks already registered in ${settingsPath} (nothing to do)`);
  }
  console.log(`\nNext: 'blackbox start' to run the daemon on 127.0.0.1:${port}.`);
  console.log('New Claude Code sessions will be recorded automatically.');
  return 0;
}

function cmdUninit(_args: Args): number {
  const { settingsPath, removed } = uninit();
  console.log(`removed ${removed} blackbox hook(s) from ${settingsPath}`);
  return 0;
}

async function cmdStart(args: Args): Promise<number> {
  const db = resolveDb(args.db);
  const port = args.port ?? DEFAULT_PORT;
  const existing = readPid();
  if (existing && isAlive(existing.pid)) {
    console.log(`blackbox daemon already running (pid ${existing.pid}, port ${existing.port})`);
    return 0;
  }
  if (existing) removePid(); // stale pid

  if (args.foreground) {
    ensureBlackboxDir();
    let daemon;
    try {
      daemon = await startDaemon({ db, port, logFile: logPath(), captureOutput: args.captureOutput });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.error(e.code === 'EADDRINUSE' ? `port ${port} is already in use` : `failed to start: ${e.message}`);
      return 2;
    }
    writePid({ pid: process.pid, port: daemon.port, db, started: new Date().toISOString() });
    console.log(`blackbox daemon listening on 127.0.0.1:${daemon.port} (db ${db})`);
    return await new Promise<number>((resolve) => {
      const shutdown = (): void => {
        void daemon.close().then(() => {
          removePid();
          resolve(0);
        });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  }

  // Background: re-spawn ourselves in --foreground, detached, logging to file.
  ensureBlackboxDir();
  const logFd = openSync(logPath(), 'a');
  const childArgs = [process.argv[1] as string, 'start', '--foreground', '--db', db, '--port', String(port)];
  if (args.captureOutput) childArgs.push('--capture-output');
  const child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  if (!(await waitForHealth(port, 3000))) {
    console.error(`daemon did not become healthy on port ${port} — check ${logPath()}`);
    return 2;
  }
  console.log(`blackbox daemon started on 127.0.0.1:${port} (db ${db})`);
  return 0;
}

async function cmdStop(_args: Args): Promise<number> {
  const p = readPid();
  if (!p) {
    console.log('blackbox daemon not running');
    return 0;
  }
  if (!isAlive(p.pid)) {
    removePid();
    console.log('blackbox daemon not running (removed stale pid)');
    return 0;
  }
  try {
    process.kill(p.pid, 'SIGTERM');
  } catch {
    /* raced with exit */
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(p.pid)) await sleep(150);
  if (isAlive(p.pid)) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  removePid();
  console.log('blackbox daemon stopped');
  return 0;
}

async function cmdStatus(_args: Args): Promise<number> {
  const p = readPid();
  if (!p || !isAlive(p.pid)) {
    if (p) removePid();
    console.log('blackbox daemon: not running');
    return 3;
  }
  const h = await getHealth(p.port);
  if (!h?.ok) {
    console.log(`blackbox daemon: pid ${p.pid} alive but not responding on port ${p.port}`);
    return 3;
  }
  console.log('blackbox daemon: running');
  console.log(`  pid ${h.pid}  port ${h.port}  uptime ${h.uptime_s}s`);
  console.log(`  db ${h.db}`);
  console.log(`  ${h.count} event(s), head seq ${h.head_seq}`);
  return 0;
}

function cmdAudit(args: Args): number {
  const store = new Store(resolveDb(args.db));
  const rows = store.events(args.session);
  store.close();
  let total = 0;
  for (const e of rows) {
    if (!e.redaction_count) continue;
    total += e.redaction_count;
    let hits: { type: string; path: string; bytes: number }[] = [];
    try {
      hits = (JSON.parse(e.detail ?? '{}').redaction ?? []) as typeof hits;
    } catch {
      /* detail is best-effort display */
    }
    console.log(`seq ${e.seq}  ${e.tool_name ?? e.hook_event}  — ${e.redaction_count} redaction(s):`);
    for (const h of hits) console.log(`    [REDACTED:${h.type}] at ${h.path} (${h.bytes} bytes)`);
  }
  console.log(`\n${total} redaction(s) across ${rows.length} event(s)`);
  return 0;
}

function cmdList(args: Args): number {
  const store = new Store(resolveDb(args.db));
  const rows = store.events(args.session);
  store.close();
  for (const e of rows) {
    const flag = e.phase === 'failure' ? '✗' : ' ';
    const target = e.target ? ` ${e.target}` : '';
    console.log(
      `${String(e.seq).padStart(4)} ${flag} ${e.ts}  ${e.phase.padEnd(13)} ${(e.tool_name ?? e.hook_event).padEnd(22)}${target}`,
    );
  }
  console.log(`\n${rows.length} event(s)`);
  return 0;
}

function cmdSessions(args: Args): number {
  const store = new Store(resolveDb(args.db));
  const sessions = store.sessions();
  store.close();
  for (const s of sessions) {
    console.log(
      `${s.session_id}  ${s.events} event(s)  ${s.failures} failure(s)  ${s.started} → ${s.ended}`,
    );
  }
  console.log(`\n${sessions.length} session(s)`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'init':
      return cmdInit(args);
    case 'uninit':
      return cmdUninit(args);
    case 'watch':
      return cmdWatch(args);
    case 'unwatch':
      return cmdUnwatch(args);
    case 'start':
      return cmdStart(args);
    case 'stop':
      return cmdStop(args);
    case 'status':
      return cmdStatus(args);
    case 'ingest':
      return cmdIngest(args);
    case 'verify':
      return cmdVerify(args);
    case 'head':
      return cmdHead(args);
    case 'list':
      return cmdList(args);
    case 'audit':
      return cmdAudit(args);
    case 'sessions':
      return cmdSessions(args);
    case undefined:
    case 'help':
      console.log(HELP);
      return cmd ? 0 : 1;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      return 2;
  }
}

void main().then((code) => process.exit(code));
