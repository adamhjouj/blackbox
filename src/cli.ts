#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { disableAutostart, enableAutostart } from './autostart';
import { DEFAULT_PORT, startDaemon } from './daemon';
import { canonical } from './hash';
import { init, uninit, versionWarning } from './init';
import { normalizeAndCapture } from './normalize';
import { buildForensicReport, buildReport, defaultReportSession } from './report';
import { loadPublicKey, loadWatermark } from './sign';
import { backfill, computeSession, rescoreSession } from './risk-engine';
import { isKnownRuleset, KNOWN_RULESETS, RULESET_VERSION, rulesFingerprint, type RulesetVersion } from './risk-rules';
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
  ruleset?: string;
  check?: boolean;
  prune?: string;
  out?: string;
  off?: boolean;
  olderThan?: string;
  forensic?: boolean;
  anchor?: string;
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
    else if (a === '--ruleset') out.ruleset = argv[++i];
    else if (a === '--check') out.check = true;
    else if (a === '--prune') out.prune = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--off') out.off = true;
    else if (a === '--older-than') out.olderThan = argv[++i];
    else if (a === '--forensic') out.forensic = true;
    else if (a === '--anchor') out.anchor = argv[++i];
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
  blackbox init                  Install hooks, start the daemon, and begin recording (one command; alias: setup)
  blackbox uninit                Remove blackbox hooks from ~/.claude/settings.json
  blackbox watch [repo]          Install git forensics hooks in a repo (--global for all repos)
  blackbox unwatch [repo]        Remove git forensics hooks (--global to disable global)
  blackbox start                 Start the localhost hook-receiver daemon (background)
  blackbox stop                  Stop the daemon
  blackbox status                Show daemon status
  blackbox ui                    Open the timeline UI in your browser (http://127.0.0.1:7842)
  blackbox autostart             Keep the daemon running across reboots (macOS LaunchAgent; --off to disable)
  blackbox ingest <file.jsonl>   Normalize raw hook payloads into the chained store
  blackbox verify                Verify the hash chain; report the first break
  blackbox rescore               Recompute the risk layer (--session, --ruleset, --check, --prune <v>)
  blackbox prune                 Age out mutation content (--older-than 30d); keeps events, hashes, and verify
  blackbox report                Export a shareable Markdown session report (--session, --ruleset, --out <file>)
                                 Add --forensic for an evidentiary case-file (custody + signature + manifest)
  blackbox head                  Print the current head anchor (seq, count, hash)
  blackbox list                  List recorded events (--session <id> to filter)
  blackbox audit                 Show what was redacted (type + path, never the secret)
  blackbox sessions              Summarize recorded sessions

Options:
  --db <path>          Store path (default: $BLACKBOX_DB or ~/.blackbox/blackbox.db)
  --port <n>           Daemon port (default: 7842)
  --foreground         Run the daemon in the foreground (start)
  --capture-output     Store tool output bodies (still redacted) instead of eliding to a hash
  --session <id>       Filter to one session (list/audit/report)
  --out <file>         Write the report to a file instead of stdout (report)
  --older-than <dur>   Retention cutoff for prune (e.g. 30d, 12h; default 30d)
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
        const { event, blob } = normalizeAndCapture(payload, capturedAt);
        const stored = store.append(event, blob);
        if (!firstSeq) firstSeq = stored.seq;
        lastSeq = stored.seq;
        n++;
      } catch (err) {
        // One bad record must never abort the run and lose the rest of the file.
        errored++;
        console.error(`ingest: failed to record a line: ${(err as Error).message}`);
      }
    }
    if (n) backfill(store); // score the ingested events (risk interpretation layer)
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
  const pubkey = loadPublicKey();
  const sigCount = store.signatures().length;
  const r = verify(store, { trustedPublicKey: pubkey, watermark: loadWatermark() });
  store.close();
  if (r.ok) {
    const anchor = r.anchored ? '' : ' (no head anchor — truncation not checked)';
    const sig = pubkey && sigCount ? ` · ${sigCount} signed checkpoint(s) OK` : pubkey ? '' : ' (unsigned — run `blackbox init` to enable signing)';
    console.log(`✓ chain intact — ${r.count} event(s) across ${r.sessions} session(s)${anchor}${sig}`);
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

async function cmdInit(args: Args): Promise<number> {
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
  // Bring the daemon up (idempotent: a healthy daemon is left as-is) and confirm /health.
  const code = await cmdStart(args);
  if (code !== 0) {
    console.error("hooks are registered, but the daemon isn't up — run 'blackbox start' and check the log.");
    return code;
  }
  console.log(`\n✓ you are recording — open the timeline UI at http://127.0.0.1:${port}/`);
  console.log('  New Claude Code sessions record automatically.');
  console.log("  Stop the daemon with 'blackbox stop'; remove hooks with 'blackbox uninit'.");
  return 0;
}

function cmdUninit(_args: Args): number {
  const { settingsPath, removed } = uninit();
  console.log(`removed ${removed} blackbox hook(s) from ${settingsPath}`);
  return 0;
}

function cmdAutostart(args: Args): number {
  if (args.off) {
    const r = disableAutostart();
    if (!r.supported) {
      console.error('autostart is macOS-only (LaunchAgent)');
      return 2;
    }
    console.log(r.action === 'removed' ? `autostart disabled (removed ${r.path})` : 'autostart was not enabled');
    return 0;
  }
  const port = args.port ?? DEFAULT_PORT;
  const r = enableAutostart({ nodePath: process.execPath, cliPath: process.argv[1] as string, port, db: args.db });
  if (!r.supported) {
    console.error('autostart is macOS-only (LaunchAgent)');
    return 2;
  }
  console.log(`autostart enabled — the daemon starts at login (${r.path})`);
  console.log("Disable it with 'blackbox autostart --off'.");
  return 0;
}

async function cmdStart(args: Args): Promise<number> {
  const db = resolveDb(args.db);
  const port = args.port ?? DEFAULT_PORT;
  const existing = readPid();
  if (existing && isAlive(existing.pid)) {
    // Confirm the PID is actually our daemon (not a recycled PID) via /health.
    const h = await getHealth(existing.port);
    if (h?.ok && h.pid === existing.pid) {
      console.log(`blackbox daemon already running (pid ${existing.pid}, port ${existing.port})`);
      return 0;
    }
  }
  if (existing) removePid(); // stale or recycled pid

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
  // Only signal a PID we've confirmed is our daemon — never a recycled PID.
  const h = await getHealth(p.port);
  if (!h?.ok || h.pid !== p.pid) {
    removePid();
    console.log('blackbox daemon not running (pid was recycled; removed stale pid)');
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

async function cmdUi(args: Args): Promise<number> {
  const p = readPid();
  const port = args.port ?? p?.port ?? DEFAULT_PORT;
  const h = await getHealth(port);
  if (!h?.ok) {
    console.error(`daemon not running on port ${port} — run 'blackbox start' first`);
    return 3;
  }
  const url = `http://127.0.0.1:${port}/`;
  console.log(`opening ${url}`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(`(open it manually: ${url})`);
  }
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

function cmdRescore(args: Args): number {
  const store = new Store(resolveDb(args.db));
  const ruleset = (args.ruleset ?? RULESET_VERSION) as RulesetVersion;
  try {
    if (!isKnownRuleset(ruleset)) {
      console.error(`unknown ruleset "${ruleset}" (known: ${KNOWN_RULESETS.join(', ')})`);
      return 2;
    }
    if (args.prune) {
      store.riskDelete(args.prune);
      console.log(`pruned risk rows for ruleset ${args.prune}`);
      return 0;
    }
    const sessionIds = args.session ? [args.session] : store.sessions().map((s) => s.session_id);
    if (args.check) {
      // Compare the ENTIRE recomputed risk layer (verdict + score + combos +
      // rule_counts + rules_hash + every per-event risk row) against what's stored
      // — so a tampered flag/evidence/count is caught even if the verdict is
      // unchanged. canonical() neutralizes key ordering. A session with NO stored
      // row for this ruleset is "not yet scored" (e.g. right after an r2 bump,
      // before backfill) and is reported separately, never counted as tampering.
      const jparse = (s: string | null, f: unknown): unknown => {
        try {
          return s ? JSON.parse(s) : f;
        } catch {
          return f;
        }
      };
      let mismatches = 0;
      let unscored = 0;
      const rulesHash = rulesFingerprint(ruleset);
      for (const sid of sessionIds) {
        const sr = store.sessionRisk(sid, ruleset);
        if (!sr) {
          unscored++;
          console.error(`  · ${sid.slice(0, 18)}: not yet scored under ruleset ${ruleset} (run backfill/rescore)`);
          continue;
        }
        const { verdict, risks } = computeSession(store, sid, ruleset);
        const recomputed = canonical({
          v: verdict.verdict, s: verdict.score, combos: verdict.combos, rc: verdict.rule_counts, last: verdict.last_scored_seq, h: rulesHash,
          risks: risks.map((r) => ({ seq: r.seq, score: r.score, flags: r.flags, evidence: r.evidence })),
        });
        const storedRisks = store.riskForSession(sid, ruleset).map((r) => ({ seq: r.seq, score: r.score, flags: jparse(r.flags, []), evidence: jparse(r.evidence, null) }));
        const stored = canonical({ v: sr.verdict, s: sr.score, combos: jparse(sr.combos, []), rc: jparse(sr.rule_counts, {}), last: sr.last_scored_seq, h: sr.rules_hash ?? null, risks: storedRisks });
        if (recomputed !== stored) {
          mismatches++;
          console.error(`  ✗ ${sid.slice(0, 18)}: risk layer differs from recomputation`);
        }
      }
      const checked = sessionIds.length - unscored;
      const tail = unscored ? ` (${unscored} not yet scored under ${ruleset})` : '';
      console.log(mismatches ? `✗ ${mismatches}/${checked} scored session(s) differ from recomputation${tail}` : `✓ all ${checked} scored session(s) match recomputation${tail}`);
      return mismatches ? 1 : 0;
    }
    let n = 0;
    for (const sid of sessionIds) {
      rescoreSession(store, sid, ruleset);
      n++;
    }
    console.log(`rescored ${n} session(s) under ruleset ${ruleset}`);
    return 0;
  } finally {
    store.close();
  }
}

/** Parse a retention duration like "30d", "12h", "45m" into milliseconds. */
function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*([smhdw])$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const unit = mult[m[2]!];
  return unit ? n * unit : null;
}

function cmdPrune(args: Args): number {
  const spec = args.olderThan ?? '30d';
  const ms = parseDuration(spec);
  if (ms == null) {
    console.error(`prune: invalid --older-than "${spec}" (use e.g. 30d, 12h, 45m)`);
    return 2;
  }
  const now = Date.now();
  const cutoff = new Date(now - ms).toISOString();
  const store = new Store(resolveDb(args.db));
  try {
    const before = verify(store);
    const r = store.prune(cutoff, new Date(now).toISOString());
    const after = verify(store);
    // The chain must be byte-identical across a prune — this is the whole point.
    if (before.ok && (!after.ok || before.count !== after.count)) {
      console.error('prune: ABORTED invariant check — chain changed across prune (this should be impossible)');
      return 1;
    }
    console.log(`pruned ${r.pruned} mutation blob(s) older than ${spec} — ${(r.bytesFreed / 1024).toFixed(1)} KiB freed`);
    console.log('events and hash chain untouched; run `blackbox verify` to confirm.');
    return 0;
  } finally {
    store.close();
  }
}

function cmdReport(args: Args): number {
  const store = new Store(resolveDb(args.db));
  try {
    // An explicit --ruleset must be a known one (mirrors cmdRescore); otherwise the
    // report resolves r2→r1 per session, so the flag is left undefined here.
    let ruleset: RulesetVersion | undefined;
    if (args.ruleset !== undefined) {
      if (!isKnownRuleset(args.ruleset)) {
        console.error(`unknown ruleset "${args.ruleset}" (known: ${KNOWN_RULESETS.join(', ')})`);
        return 2;
      }
      ruleset = args.ruleset;
    }
    const sessionId = args.session ?? defaultReportSession(store);
    if (!sessionId) {
      console.error('report: no sessions recorded');
      return 2;
    }
    const md = args.forensic
      ? buildForensicReport(store, sessionId, { ruleset, trustedPublicKey: loadPublicKey(), watermark: loadWatermark() })
      : buildReport(store, sessionId, ruleset);
    if (args.forensic && args.anchor) {
      console.error(`  (--anchor ${args.anchor} is a stub — remote head anchoring is not yet wired; see docs)`);
    }
    if (args.out) {
      writeFileSync(args.out, md);
      console.log(`wrote report for session ${sessionId} to ${args.out}`);
    } else {
      console.log(md);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'init':
    case 'setup':
      return cmdInit(args);
    case 'uninit':
      return cmdUninit(args);
    case 'autostart':
      return cmdAutostart(args);
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
    case 'ui':
      return cmdUi(args);
    case 'ingest':
      return cmdIngest(args);
    case 'verify':
      return cmdVerify(args);
    case 'rescore':
      return cmdRescore(args);
    case 'prune':
      return cmdPrune(args);
    case 'report':
      return cmdReport(args);
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
