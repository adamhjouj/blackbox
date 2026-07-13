'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rulesFingerprint, RULESET_VERSION } = require('../dist/risk-rules.js');
const { computeSession, rescoreSession, RiskEngine } = require('../dist/risk-engine.js');
const { verify } = require('../dist/verify.js');
const { normEv, injDetail, tempStore } = require('./util.js');

// r1 and r2 fingerprints are FROZEN: the exact values stored in real DBs scored
// under those codepaths. If either changes, every report on those rows silently
// loses reproducibility — so this guards each frozen spec byte-for-byte. r2 is
// frozen now that r3 is current (mirrors the r1 freeze at the r2 bump).
const GOLDEN_R1 = 'sha256:92ec93a2a2beff5d08d3f17f7db4a5ff7a4203198133a1150e5160e95282dae3';
const GOLDEN_R2 = 'sha256:320aab0226baebfbd2bcfec7a5a0e8214e15346c5ed4fcaae77696989b68ae32';

test('r1 + r2 fingerprints are byte-frozen; r3 is distinct; current is r3', () => {
  assert.equal(rulesFingerprint('r1'), GOLDEN_R1);
  assert.equal(rulesFingerprint('r2'), GOLDEN_R2);
  assert.notEqual(rulesFingerprint('r3'), GOLDEN_R1);
  assert.notEqual(rulesFingerprint('r3'), GOLDEN_R2);
  assert.equal(RULESET_VERSION, 'r3');
});

/** A crafted session that fires BOTH an injected-tamper and a tool-poisoning combo
 *  (so the persistence path exercises combos, not just per-event flags). */
function seedSession(store, sid = 'CRAFT') {
  const evs = [
    normEv({ session_id: sid, action_type: 'file_read', target: '/app/.env', redaction_count: 2 }),
    normEv({ session_id: sid, action_type: 'web_fetch', target: 'https://docs.site/x', detail: injDetail(['ignore-instructions', 'disregard']) }),
    normEv({ session_id: sid, action_type: 'file_edit', target: 'src/auth/session.ts' }),
    normEv({ session_id: sid, action_type: 'mcp_call', tool_name: 'mcp__evil__upload', target: JSON.stringify({ note: 'hi' }) }),
    normEv({ session_id: sid, action_type: 'mcp_call', tool_name: 'mcp__evil__upload', target: JSON.stringify({ file_path: '/app/.env' }) }),
  ];
  for (const e of evs) store.append(e);
  return sid;
}

const norm = (v, risks) => JSON.stringify({
  verdict: v.verdict, score: v.score, last: v.last_scored_seq,
  combos: [...(v.combos || [])].map((c) => c.id).sort(),
  rc: v.rule_counts,
  risks: (risks || []).map((r) => ({ seq: r.seq, score: r.score, flags: [...r.flags].sort() })),
});

test('the crafted session scores HIGH with both combos under r2', () => {
  const store = tempStore();
  try {
    const sid = seedSession(store);
    const { verdict } = computeSession(store, sid, 'r2');
    assert.equal(verdict.verdict, 'high');
    const ids = (verdict.combos || []).map((c) => c.id).sort();
    assert.deepEqual(ids, ['injected-tamper', 'tool-poisoning']);
  } finally {
    store.cleanup();
  }
});

test('computeSession == live per-event hydrate path (equivalence)', () => {
  const store = tempStore();
  try {
    const sid = seedSession(store);
    const offline = computeSession(store, sid, 'r2');
    // simulate the daemon: score each event as it "arrives", with hydrate wired.
    const engine = new RiskEngine((s) => store.eventsLight(s), 'r2');
    let live = null;
    const liveRisks = [];
    for (const e of store.eventsLight(sid)) {
      const r = engine.score(e);
      if (r.risk) liveRisks.push(r.risk);
      live = r.verdict;
    }
    assert.equal(norm(live, liveRisks), norm(offline.verdict, offline.risks));
  } finally {
    store.cleanup();
  }
});

test('rescore is idempotent (byte-identical rows on a second pass)', () => {
  const store = tempStore();
  try {
    const sid = seedSession(store);
    rescoreSession(store, sid, 'r2');
    const a = JSON.stringify({ s: store.sessionRisk(sid, 'r2'), r: store.riskForSession(sid, 'r2') });
    rescoreSession(store, sid, 'r2');
    const b = JSON.stringify({ s: store.sessionRisk(sid, 'r2'), r: store.riskForSession(sid, 'r2') });
    // computed_at differs by design; strip it before comparing the risk content.
    const strip = (s) => s.replace(/"computed_at":"[^"]*"/g, '"computed_at":"X"');
    assert.equal(strip(a), strip(b));
  } finally {
    store.cleanup();
  }
});

test('verify() is byte-identical before and after an r2 rescore', () => {
  const store = tempStore();
  try {
    const sid = seedSession(store);
    const before = JSON.stringify(verify(store));
    rescoreSession(store, sid, 'r2');
    const after = JSON.stringify(verify(store));
    assert.equal(before, after);
    assert.equal(JSON.parse(after).ok, true);
  } finally {
    store.cleanup();
  }
});

test('stored rows carry the r2 rules_hash, and recomputation matches it', () => {
  const store = tempStore();
  try {
    const sid = seedSession(store);
    rescoreSession(store, sid, 'r2');
    const sr = store.sessionRisk(sid, 'r2');
    assert.equal(sr.rules_hash, rulesFingerprint('r2'));
  } finally {
    store.cleanup();
  }
});
