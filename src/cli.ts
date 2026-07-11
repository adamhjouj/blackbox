#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { normalize } from './normalize';
import { resolveDb } from './paths';
import { Store } from './store';
import { verify } from './verify';

interface Args {
  _: string[];
  db?: string;
  session?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i] ?? out.db;
    else if (a === '--session') out.session = argv[++i];
    else if (a === '-h' || a === '--help') out._.push('help');
    else out._.push(a as string);
  }
  return out;
}

const HELP = `blackbox — forensic recorder for AI coding agents (Phase 0)

Usage:
  blackbox ingest <file.jsonl>   Normalize raw hook payloads into the chained store
  blackbox verify                Verify the hash chain; report the first break
  blackbox head                  Print the current head anchor (seq, count, hash)
  blackbox list                  List recorded events (--session <id> to filter)
  blackbox sessions              Summarize recorded sessions

Options:
  --db <path>        Store path (default: $BLACKBOX_DB or ./blackbox.db)
  --session <id>     Filter to one session (list)
  -h, --help         Show this help

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
        const stored = store.append(normalize(payload, trimmed, capturedAt));
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

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'ingest':
      return cmdIngest(args);
    case 'verify':
      return cmdVerify(args);
    case 'head':
      return cmdHead(args);
    case 'list':
      return cmdList(args);
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

process.exit(main());
