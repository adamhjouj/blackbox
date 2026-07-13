#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { ANCHOR_REF, emitReceipt, loadAnchorConfig, parseAnchorTarget, pushGitAnchor, readReceipts, receiptFromSignature, setAnchorLocalOnly, setAnchorTarget, type AnchorTarget } from './anchor';
import { disableAutostart, enableAutostart } from './autostart';
import { DEFAULT_PORT, startDaemon } from './daemon';
import { canonical } from './hash';
import { blastRadius } from './blast';
import { fileHistory, reconstructAt } from './filestate';
import { decideInitAnchor, ensureConfig, init, uninit, versionWarning } from './init';
import { reindexAll, search } from './search';
import { normalizeAndCapture } from './normalize';
import { persistReconciliation } from './reconcile';
import { buildForensicReport, buildReport, defaultReportSession } from './report';
import { ensureKeypair, loadPublicKey, loadWatermark, signHead } from './sign';
import { backfill, computeSession, rescoreSession } from './risk-engine';
import { isKnownRuleset, KNOWN_RULESETS, RULESET_VERSION, rulesFingerprint, type RulesetVersion } from './risk-rules';
import { unwatchGlobal, unwatchRepo, watchGlobal, watchRepo } from './watch';
import { configPath, ensureBlackboxDir, logPath, pidPath, resolveDb } from './paths';
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
  to?: string;
  useAnchors?: boolean;
  anchorTarget?: string;
  at?: number;
  rebuild?: boolean;
  allowInsecureGit?: boolean;
  localOnlyAnchor?: boolean;
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
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--at') out.at = Number(argv[++i]);
    else if (a === '--rebuild') out.rebuild = true;
    else if (a === '--allow-insecure-git') out.allowInsecureGit = true;
    else if (a === '--local-only-anchor') out.localOnlyAnchor = true;
    else if (a === '--anchors') {
      out.useAnchors = true;
      const nx = argv[i + 1];
      if (nx && !nx.startsWith('-')) out.anchorTarget = argv[++i]; // optional explicit target
    } else if (a === '-h' || a === '--help') out._.push('help');
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
  blackbox reconcile             Cross-check hooks vs git ground truth (--session, --check for details)
  blackbox report                Export a shareable Markdown session report (--session, --ruleset, --out <file>)
                                 Add --forensic for an evidentiary case-file (custody + signature + manifest)
  blackbox anchor --to <target>  Set the external anchor (file:<path> | git:<repo> | https://<url>) and emit a
                                 receipt now; also: anchor verify | anchor push
  blackbox head                  Print the current head anchor (seq, count, hash)
  blackbox list                  List recorded events (--session <id> to filter)
  blackbox audit                 Show what was redacted (type + path, never the secret)
  blackbox sessions              Summarize recorded sessions

Options:
  --db <path>          Store path (default: $BLACKBOX_DB or ~/.blackbox/blackbox.db)
  --port <n>           Daemon port (default: 7842)
  --foreground         Run the daemon in the foreground (start)
  --capture-output     Store tool output bodies (still redacted) instead of eliding to a hash
  --allow-insecure-git start: accept unauthenticated /git writes (INSECURE opt-out of the token requirement)
  --local-only-anchor  init: accept local-only custody instead of an off-machine anchor (reduced security)
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

function resolveAnchorReceipts(args: Args): { receipts: ReturnType<typeof readReceipts>; label: string } | null {
  if (!args.useAnchors) return { receipts: [], label: '' };
  const target = args.anchorTarget ? parseAnchorTarget(args.anchorTarget) : loadAnchorConfig().target;
  if (!target) {
    console.error('--anchors: no anchor target (pass one, or set it with `blackbox anchor --to <target>`)');
    return null;
  }
  return { receipts: readReceipts(target), label: anchorLabel(target) };
}

function anchorLabel(t: AnchorTarget): string {
  return t.kind === 'file' ? `file ${t.path}` : t.kind === 'git' ? `git ${t.repo}` : `url ${t.url}`;
}

function cmdVerify(args: Args): number {
  const resolved = resolveAnchorReceipts(args);
  if (!resolved) return 2;
  const store = new Store(resolveDb(args.db));
  const pubkey = loadPublicKey();
  const sigCount = store.signatures().length;
  const r = verify(store, { trustedPublicKey: pubkey, watermark: loadWatermark(), anchors: resolved.receipts });
  store.close();
  if (r.ok) {
    const anchor = r.anchored ? '' : ' (no head anchor — truncation not checked)';
    const sig = pubkey && sigCount ? ` · ${sigCount} signed checkpoint(s) OK` : pubkey ? '' : ' (unsigned — run `blackbox init` to enable signing)';
    const anc = resolved.receipts.length ? ` · ${resolved.receipts.length} external anchor(s) OK` : '';
    console.log(`✓ chain intact — ${r.count} event(s) across ${r.sessions} session(s)${anchor}${sig}${anc}`);
    return 0;
  }
  const b = r.break!;
  console.error(`✗ chain BROKEN at seq ${b.seq} (${b.reason})`);
  console.error(`  event_id: ${b.event_id}`);
  console.error(`  ${b.detail}`);
  return 1;
}

async function cmdAnchor(args: Args): Promise<number> {
  const sub = args._[1];

  if (sub === 'verify') {
    const target = args.anchorTarget ? parseAnchorTarget(args.anchorTarget) : loadAnchorConfig().target;
    if (!target) {
      console.error('anchor verify: no anchor target (set one with `blackbox anchor --to <target>`)');
      return 2;
    }
    const receipts = readReceipts(target);
    if (!receipts.length) {
      console.error(`anchor verify: no receipts found at ${anchorLabel(target)}`);
      return 2;
    }
    const store = new Store(resolveDb(args.db));
    const r = verify(store, { trustedPublicKey: loadPublicKey(), watermark: loadWatermark(), anchors: receipts });
    store.close();
    if (r.ok) {
      console.log(`✓ ${receipts.length} external anchor(s) at ${anchorLabel(target)} match the chain — no rewrite`);
      return 0;
    }
    console.error(`✗ anchor check FAILED at seq ${r.break!.seq} (${r.break!.reason})`);
    console.error(`  ${r.break!.detail}`);
    return 1;
  }

  if (sub === 'push') {
    const target = loadAnchorConfig().target;
    if (!target || target.kind !== 'git') {
      console.error('anchor push: the configured target is not a git anchor');
      return 2;
    }
    try {
      pushGitAnchor(target.repo);
      console.log(`pushed ${ANCHOR_REF} to origin`);
      return 0;
    } catch (err) {
      console.error(`anchor push failed: ${(err as Error).message}`);
      return 1;
    }
  }

  // default: `anchor --to <target>` — set the target and emit a receipt now.
  if (!args.to) {
    console.error('usage: blackbox anchor --to <file:PATH | git:REPO | https://URL>   |   anchor verify   |   anchor push');
    return 2;
  }
  let target: AnchorTarget;
  try {
    target = setAnchorTarget(args.to);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const store = new Store(resolveDb(args.db));
  const s = signHead(store, ensureKeypair(), new Date().toISOString());
  store.close();
  if (!s) {
    console.log(`anchor target set to ${args.to} (chain is empty — nothing to anchor yet).`);
    return 0;
  }
  const res = await emitReceipt(target, receiptFromSignature(s), { token: loadAnchorConfig().token });
  if (!res.ok) {
    console.error(`anchor target set to ${args.to}, but the first receipt failed to emit: ${res.error}`);
    return 1;
  }
  console.log(`anchor target set to ${args.to}; receipt for head seq ${s.seq} written.`);
  if (target.kind === 'https') console.log('  note: https anchoring sends signed head receipts off-machine — the one exception to blackbox staying local.');
  console.log('  the daemon will emit a fresh receipt at each session boundary (restart it to pick up this target).');
  return 0;
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

function cmdFile(args: Args): number {
  const path = args._[1];
  if (!path) {
    console.error('usage: blackbox file <path> --session <id> [--at <seq>]');
    return 2;
  }
  const store = new Store(resolveDb(args.db));
  try {
    const sessionId = args.session ?? defaultReportSession(store);
    if (!sessionId) {
      console.error('file: no sessions recorded (pass --session)');
      return 2;
    }
    const h = fileHistory(store, sessionId, path);
    if (!h.mutations.length) {
      console.log(`no recorded mutations for ${path} in session ${sessionId}`);
      return 0;
    }
    // --at --rebuild reconstructs the file's bytes at that seq (gated: prints the
    // confidence + a divergence reason when it can't stand behind a full state).
    if (args.rebuild && args.at !== undefined && !Number.isNaN(args.at)) {
      const r = reconstructAt(store, sessionId, path, args.at);
      if (r.confidence === 'unavailable' || (r.confidence === 'partial' && r.content == null)) {
        console.error(`file --rebuild: cannot reconstruct ${path} at seq ${args.at} (${r.confidence})`);
        if (r.divergence) console.error(`  ${r.divergence.reason} (at seq ${r.divergence.seq})`);
        return 2;
      }
      if (r.confidence !== 'exact') {
        console.error(`  [${r.confidence}${r.divergence ? ` — stopped at seq ${r.divergence.seq}: ${r.divergence.reason}` : ' — UNVERIFIED'}]`);
      }
      process.stdout.write(r.content ?? '');
      return r.confidence === 'partial' ? 1 : 0;
    }
    // --at (no --rebuild) prints one mutation's stored patch/body.
    if (args.at !== undefined && !Number.isNaN(args.at)) {
      const m = h.mutations.find((x) => x.seq === args.at);
      if (!m) {
        console.error(`file: no mutation at seq ${args.at} for ${path} (seqs: ${h.mutations.map((x) => x.seq).join(', ')})`);
        return 2;
      }
      if (m.content == null) {
        console.log(`(seq ${m.seq}: content not stored — ${m.skip_reason ?? 'pruned'})`);
        return 0;
      }
      console.log(m.content);
      return 0;
    }
    console.log(`File history — ${h.path}  (session ${sessionId})`);
    if (h.base_sha) console.log(`  git base: ${h.base_sha}`);
    for (const m of h.mutations) {
      const marks = [m.redacted ? 'redacted' : null, m.stored ? null : m.skip_reason ?? 'not-stored'].filter(Boolean).join(', ');
      console.log(`  seq ${String(m.seq).padStart(5)}  ${m.action.padEnd(10)} ${(m.tool ?? '—').padEnd(10)} +${m.diffstat.insertions} −${m.diffstat.deletions}${marks ? '  [' + marks + ']' : ''}`);
    }
    if (h.end_sha256) console.log(`  end sha256: ${h.end_sha256}`);
    console.log(`  ${h.mutations.length} mutation(s) — use \`--at <seq>\` to print one's stored patch/body`);
    return 0;
  } finally {
    store.close();
  }
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

  // Decide the custody posture FIRST (pure) — init is all-or-nothing; we never
  // silently set up recording with no off-machine anchor. Fail loudly here if none
  // resolves, before touching hooks/config, so re-running with a fix is clean.
  ensureBlackboxDir();
  const decision = decideInitAnchor({ cwd: process.cwd(), localOnly: args.localOnlyAnchor });
  if (!decision.ok) {
    console.error(decision.message);
    return 2;
  }

  const { settingsPath, addedEvents } = init(port);
  if (addedEvents.length) {
    console.log(`registered blackbox hooks for ${addedEvents.length} event(s) in ${settingsPath}`);
    console.log(`  ${addedEvents.join(', ')}`);
  } else {
    console.log(`blackbox hooks already registered in ${settingsPath} (nothing to do)`);
  }

  // Apply the anchor decision (writes config) and report the posture plainly.
  if (decision.kind === 'git') {
    setAnchorTarget(decision.spec);
    setAnchorLocalOnly(false);
    console.log(`external anchor: git receipts on ${ANCHOR_REF} → ${decision.remote} (auto-push ON)`);
  } else if (decision.kind === 'local-only') {
    setAnchorTarget(`file:${decision.path}`);
    setAnchorLocalOnly(true);
    console.log('⚠ external anchor: LOCAL-ONLY (reduced security)');
    console.log(`  receipts are written to ${decision.path} — on the SAME machine as the DB`);
    console.log('  and signing key, so a full-write attacker could rewrite history AND re-sign it');
    console.log('  undetectably. For real tamper-evidence, point --to an off-machine target:');
    console.log('    blackbox anchor --to git:<repo-with-remote>  |  file:</other/disk/receipts.jsonl>');
  } else {
    console.log(`external anchor: already configured (${anchorLabel(decision.target)})`);
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
  // Secure-by-default provisioning: ensure a /git auth token exists before the daemon
  // enforces one (first run generates it; an existing token is preserved, never
  // rotated). Skipped only under an explicit insecure opt-out — the `--allow-insecure-git`
  // flag OR a persisted `insecure_git` in config — so that mode stays genuinely
  // token-less rather than silently regaining a token.
  let cfgInsecureGit = false;
  try {
    cfgInsecureGit = (JSON.parse(readFileSync(configPath(), 'utf8')) as { insecure_git?: boolean }).insecure_git === true;
  } catch {
    /* no config yet */
  }
  if (!args.allowInsecureGit && !cfgInsecureGit) ensureConfig(port);
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
      daemon = await startDaemon({ db, port, logFile: logPath(), captureOutput: args.captureOutput, allowInsecureGit: args.allowInsecureGit });
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
  if (args.allowInsecureGit) childArgs.push('--allow-insecure-git');
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
  // Security posture — so a weaker mode is visible now, not discovered later.
  let tok = '';
  try {
    tok = (JSON.parse(readFileSync(configPath(), 'utf8')) as { token?: string }).token ?? '';
  } catch {
    /* no config */
  }
  const acfg = loadAnchorConfig();
  console.log(`  git route: ${tok ? 'authenticated' : 'UNAUTHENTICATED (insecure_git)'}`);
  console.log(
    `  external anchor: ${acfg.target ? anchorLabel(acfg.target) + (acfg.push ? ' + auto-push' : '') : acfg.localOnly ? 'local-only (reduced security)' : 'NONE (reduced security)'}`,
  );
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

function cmdReconcile(args: Args): number {
  const store = new Store(resolveDb(args.db));
  try {
    const sids = args.session ? [args.session] : store.sessions().map((s) => s.session_id);
    const now = new Date().toISOString();
    let withFindings = 0;
    let totalFindings = 0;
    let uncorroborated = 0;
    let unexplainedGaps = 0;
    for (const sid of sids) {
      const r = persistReconciliation(store, sid, now);
      if (!r.coverage.corroborated) uncorroborated++;
      if (r.findings.length) {
        withFindings++;
        totalFindings += r.findings.length;
        if (args.check) {
          console.log(`${sid.slice(0, 12)}: ${r.findings.length} discrepancy(ies)`);
          for (const f of r.findings) console.log(`  [${f.type}] ${f.path} — ${f.note}`);
        }
      }
      // R5.3 record completeness (event stream vs transcript).
      const c = r.coverage.completeness;
      if (c && c.missing.length) {
        const unexp = c.missing.filter((m) => m.explained === 'unexplained').length;
        unexplainedGaps += unexp;
        if (args.check || args.session) {
          console.log(`${sid.slice(0, 12)}: record coverage ${c.recorded}/${c.transcript_tool_uses} — ${c.missing.length} missing (${c.missing.length - unexp} daemon-down, ${unexp} UNEXPLAINED)`);
        }
      }
    }
    console.log(`reconciled ${sids.length} session(s): ${withFindings} with discrepancies (${totalFindings} total), ${uncorroborated} uncorroborated${unexplainedGaps ? `, ${unexplainedGaps} UNEXPLAINED record gap(s)` : ''}`);
    return unexplainedGaps > 0 && args.check ? 1 : 0;
  } finally {
    store.close();
  }
}

function cmdReindex(args: Args): number {
  const store = new Store(resolveDb(args.db));
  try {
    const n = reindexAll(store);
    console.log(`reindexed ${n} searchable row(s)`);
    return 0;
  } finally {
    store.close();
  }
}

function cmdSearch(args: Args): number {
  const q = args._.slice(1).join(' ').trim();
  if (!q) {
    console.error('usage: blackbox search <query>');
    return 2;
  }
  const store = new Store(resolveDb(args.db));
  try {
    const { hits } = search(store, q);
    if (!hits.length) {
      console.log(`no matches for "${q}"`);
      return 0;
    }
    console.log(`${hits.length} match(es) for "${q}":`);
    for (const h of hits) console.log(`  seq ${String(h.seq).padStart(6)}  ${h.kind.padEnd(14)} ${h.session_id.slice(0, 8)}  ${h.snippet}`);
    return 0;
  } finally {
    store.close();
  }
}

function cmdBlast(args: Args): number {
  const store = new Store(resolveDb(args.db));
  try {
    const sid = args.session ?? defaultReportSession(store);
    if (!sid) {
      console.error('blast: no sessions recorded (pass --session)');
      return 2;
    }
    const b = blastRadius(store, sid);
    console.log(`Blast radius — session ${sid.slice(0, 12)} (verdict: ${b.verdict})`);
    console.log(`  ${b.files.length} file(s) changed · ${b.secrets.length} secret(s) in scope · ${b.hosts.length} external host(s) · ${b.commits.length} commit(s)`);
    if (!b.checklist.length) {
      console.log('  no containment actions — nothing flagged.');
      return 0;
    }
    console.log('\nContainment checklist:');
    for (const it of b.checklist) console.log(`  ${it.order}. [${it.severity.toUpperCase()}] ${it.action}  (seq ${it.seqs.join(', ')})`);
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
    // Fold any configured external anchors into the case-file's custody block.
    const anchorTarget = loadAnchorConfig().target;
    const anchors = anchorTarget ? readReceipts(anchorTarget) : [];
    const md = args.forensic
      ? buildForensicReport(store, sessionId, {
          ruleset,
          trustedPublicKey: loadPublicKey(),
          watermark: loadWatermark(),
          anchors,
          anchorLabel: anchorTarget ? anchorLabel(anchorTarget) : null,
        })
      : buildReport(store, sessionId, ruleset);
    if (args.forensic && args.anchor) {
      console.error(`  (note: external anchoring is now its own command — \`blackbox anchor --to ${args.anchor}\`; --anchor on report is ignored)`);
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
    case 'reconcile':
      return cmdReconcile(args);
    case 'anchor':
      return cmdAnchor(args);
    case 'reindex':
      return cmdReindex(args);
    case 'search':
      return cmdSearch(args);
    case 'blast':
      return cmdBlast(args);
    case 'report':
      return cmdReport(args);
    case 'head':
      return cmdHead(args);
    case 'file':
      return cmdFile(args);
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
