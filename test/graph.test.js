'use strict';
// R4 provenance graph: a pure read-time projection of the story + risk combos into
// nodes/edges. No capture, nothing hashed. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGraph } = require('../dist/graph.js');

function mkStep(seq, target, o = {}) {
  return { seq, post_seq: seq, ts: 't', type: o.type || 'file_edit', tool: o.tool || 'Edit', target, summary: o.summary || 'edit ' + target, success: 1, duration_ms: 1, signals: o.signals || [], score: 0, agent_type: o.agent_type || 'main', is_subagent: !!o.sub, files: o.nofile ? [] : [{ path: target, kind: 'patch', insertions: 1, deletions: 0, status: 'stored', skip_reason: null, seq }] };
}
function mkTurn(pid, prompt, steps, commits = []) {
  const files = [];
  for (const s of steps) for (const f of s.files) files.push(f);
  return { prompt_id: pid, prompt, reasoning: null, turn_meta: null, started_at: 't', ended_at: 't', steps, files_changed: files, commits, flags: {}, flagged: 0, max_score: 0 };
}
const mkStory = (turns) => ({ session_id: 'S', name: null, cwd: '/r', verdict: 'none', turns, files_changed: [], commits: [], counts: {}, reconciliation: null });
const types = (nodes) => nodes.reduce((a, n) => ((a[n.type] = (a[n.type] || 0) + 1), a), {});

const STORY = mkStory([mkTurn('P1', 'add feature', [mkStep(2, '/r/a.ts'), mkStep(4, '/r/b.ts')], [{ seq: 6, sha: 'abc1234', subject: 'add feature' }])]);

test('overview: prompt → files + commit (steps aggregated)', () => {
  const g = buildGraph(STORY, []);
  assert.equal(g.detailed, false);
  const t = types(g.nodes);
  assert.equal(t.prompt, 1);
  assert.equal(t.file, 2);
  assert.equal(t.commit, 1);
  assert.equal(g.edges.filter((e) => e.type === 'changed').length, 2);
  assert.equal(g.edges.filter((e) => e.type === 'committed').length, 1);
});

test('detailed (?prompt): prompt → every step → files', () => {
  const g = buildGraph(STORY, [], 'P1');
  assert.equal(g.detailed, true);
  const t = types(g.nodes);
  assert.equal(t.step, 2);
  assert.equal(t.file, 2);
  assert.equal(t.prompt, 1);
  assert.equal(g.edges.filter((e) => e.type === 'caused').length, 2);
  assert.equal(g.edges.filter((e) => e.type === 'changed').length, 2);
});

test('an exfil combo draws a secret + host + a red combo path, and marks steps risky', () => {
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 4, host: 'evil.com', note: 'x' }];
  const g = buildGraph(STORY, combos, 'P1');
  const t = types(g.nodes);
  assert.equal(t.secret, 1);
  assert.equal(t.host, 1);
  const combo = g.edges.filter((e) => e.type === 'combo');
  assert.equal(combo.length, 1);
  assert.ok(combo[0].risk);
  assert.ok(g.nodes.find((n) => n.id === 's:2').risk, 'the secret-touch step is risky');
  assert.ok(g.nodes.find((n) => n.id === 's:4').risk, 'the send step is risky');
});

test('a combo with no structured host still connects the exfil path in the overview', () => {
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 4, note: 'no host field' }];
  const g = buildGraph(STORY, combos); // overview — steps aren't nodes, anchored to the prompt
  assert.equal(g.edges.filter((e) => e.type === 'combo' && e.risk).length, 1);
  assert.equal(types(g.nodes).secret, 1);
});

test('node degree counts incident edges (a file touched by two steps → degree 2)', () => {
  const g = buildGraph(mkStory([mkTurn('P1', 'x', [mkStep(2, '/r/a.ts'), mkStep(4, '/r/a.ts')])]), [], 'P1');
  const file = g.nodes.find((n) => n.type === 'file');
  assert.equal(file.degree, 2);
});

test('a subagent step nests under the spawning task (spawned edge)', () => {
  const steps = [mkStep(2, 'Explore', { type: 'task_control', tool: 'Task', nofile: true }), mkStep(4, '/r/c.ts', { sub: true, agent_type: 'Explore' })];
  const g = buildGraph(mkStory([mkTurn('P1', 'x', steps)]), [], 'P1');
  assert.equal(g.edges.filter((e) => e.type === 'spawned').length, 1);
});

test('a turn with no activity graphs to a single node (the UI hints to use Story)', () => {
  const g = buildGraph(mkStory([mkTurn('P1', 'hi', [])]), []);
  assert.equal(g.counts.nodes, 1);
});

test('?prompt isolates exactly one turn', () => {
  const s = mkStory([mkTurn('P1', 'one', [mkStep(2, '/r/a.ts')]), mkTurn('P2', 'two', [mkStep(4, '/r/b.ts')])]);
  const g = buildGraph(s, [], 'P2');
  assert.ok(g.nodes.find((n) => n.id === 'p:P2'));
  assert.ok(!g.nodes.find((n) => n.id === 'p:P1'), 'P1 must be excluded');
  const files = g.nodes.filter((n) => n.type === 'file');
  assert.equal(files.length, 1);
  assert.equal(files[0].label, 'b.ts');
});

test('drill-in seqs: step uses post_seq; file/commit use their own seq', () => {
  const step = { seq: 2, post_seq: 3, ts: 't', type: 'file_edit', tool: 'Edit', target: '/r/a.ts', summary: 'e', success: 1, duration_ms: 1, signals: [], score: 0, agent_type: 'main', is_subagent: false, files: [{ path: '/r/a.ts', kind: 'patch', insertions: 1, deletions: 0, status: 'stored', skip_reason: null, seq: 3 }] };
  const g = buildGraph(mkStory([mkTurn('P1', 'x', [step], [{ seq: 6, sha: 'abc1234', subject: 'c' }])]), [], 'P1');
  assert.equal(g.nodes.find((n) => n.type === 'step').seq, 3, 'step drills into post_seq');
  assert.equal(g.nodes.find((n) => n.type === 'file').seq, 3);
  assert.equal(g.nodes.find((n) => n.type === 'commit').seq, 6);
});

test('an injected-* combo yields the same secret/host/red-path shape as exfil-chain', () => {
  const g = buildGraph(STORY, [{ id: 'injected-exfil', severity: 'high', antecedent_seq: 2, consequent_seq: 4, host: 'evil.com', note: 'x' }], 'P1');
  assert.equal(types(g.nodes).secret, 1);
  assert.equal(types(g.nodes).host, 1);
  assert.equal(g.edges.filter((e) => e.type === 'combo' && e.risk).length, 1);
});

test('a tool-poisoning combo (server field) yields an mcp node, no phantom secret/host', () => {
  const g = buildGraph(STORY, [{ id: 'tool-poisoning', severity: 'high', antecedent_seq: 0, consequent_seq: 0, server: 'evil-mcp', note: 'x' }]);
  assert.equal(types(g.nodes).mcp, 1);
  assert.ok(g.nodes.find((n) => n.id === 'mcp:evil-mcp' && n.risk));
  assert.ok(!types(g.nodes).secret && !types(g.nodes).host);
});

test('same-basename files are distinct nodes; a step and a commit can share a seq', () => {
  const g = buildGraph(mkStory([mkTurn('P1', 'x', [mkStep(2, '/r/a.ts'), mkStep(4, '/r/sub/a.ts')])]), [], 'P1');
  assert.equal(types(g.nodes).file, 2, 'distinct ids, same basename label');
  const step6 = { seq: 6, post_seq: 6, ts: 't', type: 'shell_command', tool: 'Bash', target: 'git commit', summary: 'c', success: 1, duration_ms: 1, signals: [], score: 0, agent_type: 'main', is_subagent: false, files: [] };
  const g2 = buildGraph(mkStory([mkTurn('P1', 'x', [step6], [{ seq: 6, sha: 'abc', subject: 'c' }])]), [], 'P1');
  assert.ok(g2.nodes.find((n) => n.id === 's:6') && g2.nodes.find((n) => n.id === 'c:6'), 'step and commit at seq 6 are distinct nodes');
});

test('an empty story graphs to nothing and JSON round-trips', () => {
  const g = buildGraph(mkStory([]), []);
  assert.equal(g.counts.nodes, 0);
  assert.equal(g.counts.edges, 0);
  assert.equal(g.session_id, 'S');
  assert.doesNotThrow(() => JSON.stringify(g));
});

test('a file changed across two turns is one node with degree 2 (overview dedup)', () => {
  const g = buildGraph(mkStory([mkTurn('P1', 'a', [mkStep(2, '/r/shared.ts')]), mkTurn('P2', 'b', [mkStep(4, '/r/shared.ts')])]), []);
  assert.equal(types(g.nodes).file, 1);
  assert.equal(g.nodes.find((n) => n.type === 'file').degree, 2);
  assert.equal(g.edges.filter((e) => e.type === 'changed').length, 2);
});

test('a dangling combo (seqs anchor nowhere) still shows secret+host+combo, no read/sent', () => {
  const g = buildGraph(STORY, [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 999, consequent_seq: 998, host: 'evil.com', note: 'x' }], 'P1');
  assert.equal(types(g.nodes).secret, 1);
  assert.equal(types(g.nodes).host, 1);
  assert.equal(g.edges.filter((e) => e.type === 'combo').length, 1);
  assert.equal(g.edges.filter((e) => e.type === 'read' || e.type === 'sent').length, 0);
});
