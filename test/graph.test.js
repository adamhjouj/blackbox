'use strict';
// R4 provenance TREE: a pure read-time projection of the story (+ risk combos) into a
// rooted tree — prompt -> files/commits/subagents/risk. No capture, nothing hashed.
// Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTree } = require('../dist/graph.js');

function mkStep(seq, target, o = {}) {
  return { seq, post_seq: seq, ts: 't', type: o.type || 'file_edit', tool: o.tool || 'Edit', target, summary: o.summary || 'edit ' + target, success: 1, duration_ms: 1, signals: o.signals || [], score: 0, agent_type: o.agent_type || 'main', is_subagent: !!o.sub, files: o.nofile ? [] : [{ path: target, kind: 'patch', insertions: o.ins == null ? 1 : o.ins, deletions: o.del || 0, status: 'stored', skip_reason: null, seq }] };
}
function mkTurn(pid, prompt, steps, commits = [], o = {}) {
  const files = [];
  for (const s of steps) for (const f of s.files) files.push(f);
  return { prompt_id: pid, prompt, reasoning: null, turn_meta: null, started_at: 't', ended_at: 't', steps, files_changed: files, commits, flags: {}, flagged: o.flagged || 0, max_score: 0 };
}
const mkStory = (turns, o = {}) => ({ session_id: 'S', name: o.name || 'test session', cwd: '/r', verdict: o.verdict || 'none', turns, files_changed: [], commits: [], counts: {}, reconciliation: null });
const kid = (n, type) => n.children.find((c) => c.type === type);
const kids = (n, type) => n.children.filter((c) => c.type === type);

const COMMIT = { seq: 6, sha: 'abc1234', subject: 'add feature', ref: null, kind: 'commit', insertions: 2, deletions: 0, files: 2 };
const STORY = mkStory([mkTurn('P1', 'add feature', [mkStep(2, '/r/a.ts'), mkStep(4, '/r/b.ts')], [COMMIT])]);

test('overview: a session root with one prompt node per turn', () => {
  const t = buildTree(STORY, []);
  assert.equal(t.detailed, false);
  assert.equal(t.root.type, 'session');
  assert.equal(t.root.label, 'test session');
  const prompts = kids(t.root, 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].label, 'add feature');
});

test('a prompt branches into the files it changed and the commits it made', () => {
  const prompt = kids(buildTree(STORY, []).root, 'prompt')[0];
  const files = kids(prompt, 'file');
  assert.deepEqual(files.map((f) => f.label).sort(), ['a.ts', 'b.ts']);
  assert.equal(files[0].sub, '+1', 'file carries its churn');
  assert.equal(files[0].seq, 2, 'file drills into its POST seq');
  const commit = kid(prompt, 'commit');
  assert.equal(commit.label, 'abc1234 add feature');
  assert.equal(commit.seq, 6);
});

test('the prompt subtitle summarises the outcome counts', () => {
  const prompt = kids(buildTree(STORY, []).root, 'prompt')[0];
  assert.equal(prompt.sub, '2 steps · 2 files · 1 commit');
});

test('detailed (?prompt): the turn becomes the root, fully described', () => {
  const t = buildTree(STORY, [], 'P1');
  assert.equal(t.detailed, true);
  assert.equal(t.root.type, 'prompt');
  assert.equal(t.root.label, 'add feature');
  assert.equal(kids(t.root, 'file').length, 2);
  assert.equal(kids(t.root, 'commit').length, 1);
});

test('a delegated subagent appears as a node with its step count', () => {
  const steps = [mkStep(2, 'Explore', { type: 'task_control', tool: 'Task', nofile: true }), mkStep(4, '/r/c.ts', { sub: true, agent_type: 'Explore' })];
  const prompt = kids(buildTree(mkStory([mkTurn('P1', 'x', steps)]), []).root, 'prompt')[0];
  const sub = kid(prompt, 'subagent');
  assert.ok(sub, 'a subagent node exists');
  assert.equal(sub.label, 'Explore');
  assert.equal(sub.sub, '1 step');
});

test('an exfil combo attaches a secret (and host) leaf to the turn that produced it', () => {
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 2, consequent_seq: 4, host: 'evil.com', note: 'x' }];
  const prompt = kids(buildTree(mkStory([mkTurn('P1', 'risky', [mkStep(2, '/r/.env'), mkStep(4, '/r/x.ts')], [], { flagged: 1 })]), combos).root, 'prompt')[0];
  const secret = kid(prompt, 'secret');
  assert.ok(secret && secret.risk, 'a risk-flagged secret node hangs off the prompt');
  const host = kid(secret, 'host');
  assert.ok(host && host.risk, 'the host it was sent to nests under the secret');
  assert.equal(host.label, 'evil.com');
  assert.ok(prompt.risk, 'the flagged prompt is itself marked risky');
});

test('a combo that anchors to no visible turn is never fabricated', () => {
  const combos = [{ id: 'exfil-chain', severity: 'high', antecedent_seq: 999, consequent_seq: 998, host: 'evil.com', note: 'x' }];
  const prompt = kids(buildTree(STORY, combos).root, 'prompt')[0];
  assert.equal(kids(prompt, 'secret').length, 0);
  assert.equal(kids(prompt, 'host').length, 0);
});

test('a tool-poisoning combo yields an mcp node, no phantom secret/host', () => {
  const combos = [{ id: 'tool-poisoning', severity: 'high', antecedent_seq: 2, consequent_seq: 4, server: 'evil-mcp', note: 'x' }];
  const prompt = kids(buildTree(STORY, combos).root, 'prompt')[0];
  const mcp = kid(prompt, 'mcp');
  assert.ok(mcp && mcp.risk && mcp.label === 'evil-mcp');
  assert.equal(kids(prompt, 'secret').length, 0);
});

test('lifecycle turns with no prompt and no activity are dropped from the overview', () => {
  const s = mkStory([mkTurn(null, null, []), mkTurn('P1', 'real work', [mkStep(2, '/r/a.ts')])]);
  const prompts = kids(buildTree(s, []).root, 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].label, 'real work');
});

test('a turn with a prompt but no changes is kept (it is a real ask) and reads "no changes"', () => {
  const prompt = kids(buildTree(mkStory([mkTurn('P1', 'just asking', [])]), []).root, 'prompt')[0];
  assert.equal(prompt.label, 'just asking');
  assert.equal(prompt.sub, 'no changes');
  assert.equal(prompt.children.length, 0);
});

test('a same-basename file in two turns is a distinct node under each turn', () => {
  const s = mkStory([mkTurn('P1', 'a', [mkStep(2, '/r/a.ts')]), mkTurn('P2', 'b', [mkStep(4, '/r/sub/a.ts')])]);
  const prompts = kids(buildTree(s, []).root, 'prompt');
  assert.equal(prompts.length, 2);
  assert.equal(kid(prompts[0], 'file').label, 'a.ts');
  assert.equal(kid(prompts[1], 'file').label, 'a.ts');
  assert.notEqual(kid(prompts[0], 'file').id, kid(prompts[1], 'file').id, 'distinct ids so they never merge');
});

test('an unknown ?prompt degrades gracefully (no crash, empty root)', () => {
  const t = buildTree(STORY, [], 'NOPE');
  assert.equal(t.root.sub, 'turn not found');
  assert.equal(t.root.children.length, 0);
});

test('node count is reported and the whole tree is JSON-serialisable', () => {
  const t = buildTree(STORY, []);
  // session + prompt + 2 files + 1 commit = 5
  assert.equal(t.counts.nodes, 5);
  assert.equal(t.session_id, 'S');
  assert.doesNotThrow(() => JSON.stringify(t));
});

test('an empty story yields a session root with no children', () => {
  const t = buildTree(mkStory([]), []);
  assert.equal(t.root.type, 'session');
  assert.equal(t.root.children.length, 0);
  assert.equal(t.counts.nodes, 1);
});
