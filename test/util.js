'use strict';
// Shared fixture builders for the risk-engine tests. Tests require the COMPILED
// output (dist/) so they validate exactly what ships — run `npm run build` first.
const crypto = require('node:crypto');

/** A minimal BlackboxEvent for RiskEngine.score()/evaluateEvent() — only the
 *  columns the risk layer reads. Feed these in ascending `seq` order. */
function ev(seq, o = {}) {
  return {
    seq,
    session_id: o.session_id || 'S',
    tool_use_id: 'tool_use_id' in o ? o.tool_use_id : 't' + seq,
    prompt_id: 'prompt_id' in o ? o.prompt_id : 'p1',
    phase: o.phase || 'post',
    hook_event: o.hook_event || 'PostToolUse',
    tool_name: 'tool_name' in o ? o.tool_name : null,
    action_type: o.action_type || 'other',
    target: 'target' in o ? o.target : null,
    agent_type: o.agent_type || 'main',
    redaction_count: o.redaction_count || 0,
    detail: 'detail' in o ? o.detail : null,
    success: 'success' in o ? o.success : 1,
  };
}

/** The hashed `detail` an injection-shaped output carries (as normalize() writes it). */
function injDetail(patterns) {
  return JSON.stringify({ output_signals: { injection: patterns, truncated: false, scanner_version: 'i1' } });
}

/** A full NormalizedEvent for Store.append() (all columns defaulted). */
function normEv(o = {}) {
  const now = o.ts || '2026-01-01T00:00:00.000Z';
  return {
    event_id: crypto.randomUUID(),
    session_id: o.session_id || 'S',
    tool_use_id: 'tool_use_id' in o ? o.tool_use_id : null,
    prompt_id: 'prompt_id' in o ? o.prompt_id : 'p1',
    phase: o.phase || 'post',
    hook_event: o.hook_event || 'PostToolUse',
    tool_name: 'tool_name' in o ? o.tool_name : null,
    action_type: o.action_type || 'other',
    target: 'target' in o ? o.target : null,
    agent_id: o.agent_id || null,
    agent_type: o.agent_type || 'main',
    cwd: o.cwd || '/repo',
    permission_mode: o.permission_mode || 'default',
    success: 'success' in o ? o.success : 1,
    duration_ms: o.duration_ms || null,
    ts: now,
    captured_at: now,
    raw: o.raw || JSON.stringify({ ok: true }),
    output_hash: o.output_hash || null,
    output_size_bytes: o.output_size_bytes || null,
    redaction_count: o.redaction_count || 0,
    detail: 'detail' in o ? o.detail : null,
  };
}

/** A throwaway on-disk Store; caller must call .cleanup(). */
function tempStore() {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { Store } = require('../dist/store.js');
  const base = path.join(os.tmpdir(), `bbtest-${process.pid}-${crypto.randomUUID().slice(0, 8)}.db`);
  const store = new Store(base);
  store.dbPath = base; // exposed so adversarial tests can open a raw 2nd connection to tamper
  store.cleanup = () => {
    store.close();
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(base + ext, { force: true });
      } catch {
        /* best-effort */
      }
    }
  };
  return store;
}

module.exports = { ev, injDetail, normEv, tempStore };
