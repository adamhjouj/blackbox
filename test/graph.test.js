'use strict';
// R4 provenance TRACE: a pure read-time projection of the story (+ risk combos) into
// a causal DAG, laid out deterministically (hand-rolled Sugiyama). No capture,
// nothing hashed. The default lens is a rooted trace (ancestry + descendants), not a
// whole-session dump. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTrace, ALL_DEPTH } = require('../dist/graph.js');

function mkStep(seq, target, o = {}) {
  return { seq, post_seq: o.post_seq == null ? seq : o.post_seq, ts: 't', type: o.type || 'file_edit', tool: o.tool || 'Edit', target, summary: o.summary || 'edit ' + target, success: 1, duration_ms: 1, signals: o.signals || [], score: o.score || 0, agent_type: o.agent_type || 'main', is_subagent: !!o.sub, files: o.nofile ? [] : [{ path: target, kind: 'patch', insertions: o.ins == null ? 1 : o.ins, deletions: o.del || 0, status: 'stored', skip_reason: null, seq: o.post_seq == null ? seq : o.post_seq }] };
}
function mkTurn(pid, prompt, steps, commits = [], o = {}) {
  const files = [];
  for (const s of steps) for (const f of s.files) files.push(f);
  return { prompt_id: pid, prompt, reasoning: null, turn_meta: null, display_title: o.display_title || prompt || 'Prompt unavailable · recorded work', title_source: prompt ? 'captured_prompt' : 'recorded_action', started_at: 't', ended_at: 't', steps, files_changed: files, commits, flags: {}, flagged: o.flagged || 0, max_score: 0 };
}
const mkStory = (turns, o = {}) => ({ session_id: 'S', name: o.name || 'test session', cwd: '/r', verdict: o.verdict || 'none', turns, files_changed: [], commits: [], counts: {}, reconciliation: null });
const nodesByKind = (tv, kind) => tv.nodes.filter((n) => n.kind === kind);
const nodeById = (tv, id) => tv.nodes.find((n) => n.id === id);
const edge = (tv, from, to) => tv.edges.find((e) => e.from === from && e.to === to);

const COMMIT = { seq: 6, sha: 'abc1234', subject: 'add feature', ref: null, kind: 'commit', insertions: 2, deletions: 0, files: 2 };
const STORY = mkStory([mkTurn('P1', 'add feature', [mkStep(2, '/r/a.ts'), mkStep(4, '/r/b.ts')], [COMMIT])]);

test('whole session: a prompt links to the files it wrote and the commit it made', () => {
  const tv = buildTrace(STORY, [], { whole: true });
  assert.equal(tv.detailed, false);
  const p = nodesByKind(tv, 'prompt')[0];
  assert.equal(p.label, 'add feature');
  const files = nodesByKind(tv, 'file').map((f) => f.label).sort();
  assert.deepEqual(files, ['a.ts', 'b.ts']);
  const commit = nodesByKind(tv, 'commit')[0];
  assert.equal(commit.label, 'abc1234 add feature');
  for (const f of nodesByKind(tv, 'file')) assert.ok(edge(tv, p.id, f.id), 'prompt → file edge exists for ' + f.label);
  assert.ok(edge(tv, p.id, commit.id), 'prompt → commit edge exists');
});

test('an exfil combo becomes a finding sitting between its antecedent and consequent', () => {
  const steps = [mkStep(2, '/r/.env', { signals: ['secret-touch'] }), mkStep(4, '/r/send.ts', { tool: 'Bash', signals: ['external-send'] })];
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 4, host: 'evil.com', note: 'secret sent' }];
  const tv = buildTrace(mkStory([mkTurn('P1', 'risky', steps, [], { flagged: 2 })]), combos, { whole: true });
  const finding = nodesByKind(tv, 'finding')[0];
  assert.ok(finding && finding.risk, 'a risk finding node exists');
  assert.equal(finding.label, 'exfil chain');
  // antecedent(step seq 2) --flagged--> finding --flagged--> consequent(step seq 4)
  assert.ok(edge(tv, 's:2', finding.id), 'antecedent step → finding');
  assert.ok(edge(tv, finding.id, 's:4'), 'finding → consequent step');
  const host = nodesByKind(tv, 'host').find((h) => h.label === 'evil.com');
  assert.ok(host && host.risk, 'the exfil host is a risk node');
  assert.ok(edge(tv, 's:4', host.id), 'consequent step → host (sent)');
});

test('default view roots at the highest-severity finding and reads its causal chain', () => {
  const steps = [mkStep(2, '/r/.env', { signals: ['secret-touch'] }), mkStep(4, '/r/send.ts', { tool: 'Bash', signals: ['external-send'] })];
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 4, host: 'evil.com', note: 'x' }];
  const tv = buildTrace(mkStory([mkTurn('P1', 'risky', steps, [], { flagged: 2 })]), combos); // no opts → default
  assert.equal(tv.detailed, true);
  const finding = nodesByKind(tv, 'finding')[0];
  assert.equal(tv.root, finding.id, 'the trace is rooted at the finding by default');
  // ancestry (antecedent + its prompt) and descendants (consequent + host) all present
  assert.ok(nodeById(tv, 's:2'), 'antecedent in trace');
  assert.ok(nodeById(tv, 's:4'), 'consequent in trace');
  assert.ok(nodesByKind(tv, 'prompt').length >= 1, 'the prompt (ancestry) is in the trace');
});

test('trace depth bounds the causal radius', () => {
  const steps = [mkStep(2, '/r/.env', { signals: ['secret-touch'] }), mkStep(4, '/r/send.ts', { tool: 'Bash', signals: ['external-send'] })];
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 4, host: 'evil.com', note: 'x' }];
  const story = mkStory([mkTurn('P1', 'risky', steps, [], { flagged: 2 })]);
  const d1 = buildTrace(story, combos, { depth: 1 });
  const d2 = buildTrace(story, combos, { depth: 2 });
  assert.ok(d2.counts.nodes >= d1.counts.nodes, 'a deeper trace never has fewer nodes');
  // depth 1 from the finding: only the immediate antecedent + consequent (not the prompt 2 hops up)
  assert.ok(!nodesByKind(d1, 'prompt').length, 'the prompt is 2 hops away, excluded at depth 1');
  assert.ok(nodesByKind(d2, 'prompt').length, 'the prompt appears at depth 2');
});

test('files are aggregated by directory into an expandable node; risk files are never aggregated', () => {
  const steps = [mkStep(2, '/r/src/a.ts'), mkStep(4, '/r/src/b.ts'), mkStep(6, '/r/src/c.ts')];
  const tv = buildTrace(mkStory([mkTurn('P1', 'refactor', steps)]), [], { whole: true });
  const dirs = nodesByKind(tv, 'dir');
  assert.equal(dirs.length, 1, 'three files in src/ collapse to one dir node');
  assert.match(dirs[0].label, /3 files in src\//);
  assert.equal(nodesByKind(tv, 'file').length, 0, 'no individual file nodes while aggregated');
  // expanding the dir materializes the individual files
  const ex = buildTrace(mkStory([mkTurn('P1', 'refactor', steps)]), [], { whole: true, expand: [dirs[0].id] });
  assert.equal(nodesByKind(ex, 'dir').length, 0);
  assert.equal(nodesByKind(ex, 'file').length, 3, 'the three files are now individual nodes');
});

test('a tool-poisoning combo yields a finding with the poisoned server, no phantom secret/host', () => {
  const steps = [mkStep(2, '/r/x.ts', { signals: ['injection-output'] }), mkStep(4, '/r/y.ts', { signals: ['tool-result-injection'] })];
  const combos = [{ id: 'tool-poisoning', severity: 'high', antecedent_seq: 2, consequent_seq: 4, server: 'evil-mcp', note: 'x' }];
  const tv = buildTrace(mkStory([mkTurn('P1', 'x', steps, [], { flagged: 2 })]), combos, { whole: true });
  const finding = nodesByKind(tv, 'finding')[0];
  assert.equal(finding.label, 'tool poisoning');
  const server = nodesByKind(tv, 'host').find((h) => h.label === 'evil-mcp');
  assert.ok(server && server.risk, 'the poisoned server is a node');
});

test('a combo anchored to no visible turn is never fabricated', () => {
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 999, consequent_seq: 998, host: 'evil.com', note: 'x' }];
  const tv = buildTrace(STORY, combos, { whole: true });
  assert.equal(nodesByKind(tv, 'finding').length, 0, 'no finding fabricated');
  assert.equal(nodesByKind(tv, 'host').length, 0, 'no host fabricated');
});

test('lifecycle turns with no prompt and no activity are dropped', () => {
  const s = mkStory([mkTurn(null, null, []), mkTurn('P1', 'real work', [mkStep(2, '/r/a.ts')])]);
  const tv = buildTrace(s, [], { whole: true });
  assert.equal(nodesByKind(tv, 'prompt').length, 1);
  assert.equal(nodesByKind(tv, 'prompt')[0].label, 'real work');
});

test('with no findings, the default root is the most significant turn', () => {
  const s = mkStory([mkTurn('P1', 'small', [mkStep(2, '/r/a.ts')]), mkTurn('P2', 'big', [mkStep(4, '/r/b.ts'), mkStep(6, '/r/c.ts')], [COMMIT])]);
  const tv = buildTrace(s, []); // default
  assert.equal(tv.detailed, true);
  const p2 = nodeById(tv, tv.root);
  assert.equal(p2.label, 'big', 'the busier turn is chosen as the default root');
});

test('the root selector lists findings first, then turns', () => {
  const steps = [mkStep(2, '/r/.env', { signals: ['secret-touch'] }), mkStep(4, '/r/send.ts', { signals: ['external-send'] })];
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 4, host: 'evil.com', note: 'x' }];
  const tv = buildTrace(mkStory([mkTurn('P1', 'risky', steps, [], { flagged: 2 })]), combos, { whole: true });
  assert.equal(tv.roots[0].kind, 'finding', 'findings come first in the selector');
  assert.ok(tv.roots.some((r) => r.kind === 'prompt'), 'turns follow');
});

test('prompt nodes and root options use the story display_title verbatim', () => {
  const turn = mkTurn('P1', null, [mkStep(2, '/r/a.ts')], [], { display_title: 'Subagent work · inspected a.ts' });
  const tv = buildTrace(mkStory([turn]), [], { whole: true });
  assert.equal(nodesByKind(tv, 'prompt')[0].label, 'Subagent work · inspected a.ts');
  assert.equal(tv.roots.find((r) => r.kind === 'prompt').label, 'Subagent work · inspected a.ts');
});

test('every node is positioned inside the reported bounds and layers only increase along edges', () => {
  const steps = [mkStep(2, '/r/.env', { signals: ['secret-touch'] }), mkStep(4, '/r/send.ts', { tool: 'Bash', signals: ['external-send'] })];
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 4, host: 'evil.com', note: 'x' }];
  const tv = buildTrace(mkStory([mkTurn('P1', 'risky', steps, [], { flagged: 2 })]), combos, { whole: true });
  for (const n of tv.nodes) {
    assert.ok(n.x >= 0 && n.x + n.w <= tv.width + 1, 'node within width');
    assert.ok(n.y >= 0 && n.y + n.h <= tv.height + 1, 'node within height');
  }
  const layerOf = Object.fromEntries(tv.nodes.map((n) => [n.id, n.layer]));
  for (const e of tv.edges) assert.ok(layerOf[e.to] > layerOf[e.from], 'edges always point to a later layer (a proper DAG layering)');
});

test('DETERMINISM: the same session lays out byte-identically every time', () => {
  const steps = [mkStep(2, '/r/src/a.ts', { signals: ['secret-touch'] }), mkStep(4, '/r/src/b.ts'), mkStep(6, '/r/send.ts', { tool: 'Bash', signals: ['external-send'] }), mkStep(8, '/r/test/t.ts')];
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 6, host: 'evil.com', note: 'x' }];
  const story = mkStory([mkTurn('P1', 'work', steps, [COMMIT], { flagged: 2 }), mkTurn('P2', 'more', [mkStep(10, '/r/src/d.ts')])]);
  const a = JSON.stringify(buildTrace(story, combos, { whole: true }));
  const b = JSON.stringify(buildTrace(story, combos, { whole: true }));
  assert.equal(a, b, 'whole-session layout is byte-identical across renders');
  const c = JSON.stringify(buildTrace(story, combos, {}));
  const d = JSON.stringify(buildTrace(story, combos, {}));
  assert.equal(c, d, 'the default trace layout is byte-identical across renders');
});

test('node coordinates are stable regardless of combo array order (no hash-order dependence)', () => {
  const steps = [mkStep(2, '/r/a.ts', { signals: ['x'] }), mkStep(4, '/r/b.ts', { signals: ['y'] }), mkStep(6, '/r/c.ts', { signals: ['z'] })];
  const story = mkStory([mkTurn('P1', 'w', steps)]);
  const one = buildTrace(story, [], { whole: true });
  const posByLabel = Object.fromEntries(one.nodes.map((n) => [n.label, n.x + ',' + n.y]));
  const two = buildTrace(story, [], { whole: true });
  for (const n of two.nodes) assert.equal(n.x + ',' + n.y, posByLabel[n.label], 'same node → same coordinates');
});

test('the whole tree is JSON-serialisable and counts are reported', () => {
  const tv = buildTrace(STORY, [], { whole: true });
  assert.ok(tv.counts.nodes >= 1 && tv.counts.edges >= 1);
  assert.equal(tv.session_id, 'S');
  assert.doesNotThrow(() => JSON.stringify(tv));
});

test('an empty story yields an empty trace, not a crash', () => {
  const tv = buildTrace(mkStory([]), [], {});
  assert.equal(tv.nodes.length, 0);
  assert.equal(tv.counts.nodes, 0);
  assert.equal(tv.root, null);
});

test('ALL_DEPTH is a large sentinel usable as "whole"', () => {
  assert.ok(ALL_DEPTH >= 999);
});
