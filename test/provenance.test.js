'use strict';
// Provenance projector: the flat event stream → a re-traceable session story
// (turns → steps → outcomes). Pure — actions + a per-seq detail map in, a
// SessionStory out — so it tests without a store. Requires dist/ (run build).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildStory } = require('../dist/provenance.js');

let SEQ = 0;
function act(o = {}) {
  return {
    key: o.key ?? 'k' + ++SEQ,
    seq: o.seq ?? ++SEQ,
    post_seq: o.post_seq ?? null,
    ts: o.ts ?? '2026-02-01T00:00:00.000Z',
    hook_event: o.hook_event ?? 'PreToolUse',
    type: o.type ?? 'file_edit',
    tool: o.tool ?? 'Edit',
    target: o.target ?? null,
    summary: o.summary ?? '',
    phase: o.phase ?? 'post',
    success: o.success ?? 1,
    duration_ms: o.duration_ms ?? null,
    redaction_count: o.redaction_count ?? 0,
    signals: o.signals ?? [],
    notes: o.notes ?? [],
    score: o.score ?? 0,
    prompt_id: o.prompt_id ?? null,
    agent_type: o.agent_type ?? 'main',
  };
}
const mut = (insertions, deletions, kind = 'patch', extra = {}) => ({ mutation: { kind, diffstat: { files: 1, insertions, deletions }, stored: true, ...extra } });

function story(actions, detail = {}) {
  const detailBySeq = new Map(Object.entries(detail).map(([k, v]) => [Number(k), v]));
  return buildStory({ session_id: 'S', name: 'demo', cwd: '/repo', verdict: 'low', actions, detailBySeq });
}

// ---- the headline: prompt → steps → files + commit, subagent nested --------
test('a full turn projects prompt, ordered steps, files changed, and the commit', () => {
  const actions = [
    act({ seq: 1, phase: 'prompt', hook_event: 'UserPromptSubmit', type: 'session', tool: null, prompt_id: 'P1' }),
    act({ seq: 2, post_seq: 3, type: 'file_edit', target: '/repo/a.ts', prompt_id: 'P1' }),
    act({ seq: 4, post_seq: 5, type: 'file_write', tool: 'Write', target: '/repo/b.ts', prompt_id: 'P1' }),
    act({ seq: 6, post_seq: 7, type: 'task_control', tool: 'Task', target: 'Explore', prompt_id: 'P1' }),
    act({ seq: 8, post_seq: 9, type: 'file_edit', target: '/repo/c.ts', prompt_id: 'P1', agent_type: 'Explore' }),
    act({ seq: 10, hook_event: 'GitRefTransaction', type: 'git_action', tool: 'git', prompt_id: null }),
  ];
  const detail = {
    1: { prompt: 'add feature X' },
    3: mut(2, 1),
    5: mut(10, 0, 'body'),
    9: mut(3, 3),
    10: { git: { ref: 'refs/heads/main', kind: 'commit', diffstat: { files: 3, insertions: 15, deletions: 4 }, commit: { sha: 'abc1234def', subject: 'add feature X' } } },
  };
  const s = story(actions, detail);

  assert.equal(s.turns.length, 1);
  const t = s.turns[0];
  assert.equal(t.prompt_id, 'P1');
  assert.equal(t.prompt, 'add feature X');
  assert.equal(t.steps.length, 4); // edit, write, task, subagent-edit — the commit is NOT a step
  assert.deepEqual(t.steps.map((x) => x.target), ['/repo/a.ts', '/repo/b.ts', 'Explore', '/repo/c.ts']);

  // the commit is an outcome, not a step
  assert.equal(t.commits.length, 1);
  assert.equal(t.commits[0].sha, 'abc1234def');
  assert.equal(t.commits[0].subject, 'add feature X');

  // files changed rollup for the turn
  assert.deepEqual(t.files_changed.map((f) => f.path).sort(), ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);

  // subagent attribution
  const cStep = t.steps.find((x) => x.target === '/repo/c.ts');
  assert.equal(cStep.is_subagent, true);
  assert.equal(t.steps.find((x) => x.target === '/repo/a.ts').is_subagent, false);

  assert.deepEqual(s.counts, { turns: 1, steps: 4, files: 3, commits: 1 });
});

// ---- graceful degradation: pre-capture sessions still group into turns -----
test('sessions recorded before prompt capture still split into turns by prompt_id', () => {
  const actions = [
    act({ seq: 1, post_seq: 2, target: '/repo/a.ts', prompt_id: 'PX' }),
    act({ seq: 3, post_seq: 4, target: '/repo/b.ts', prompt_id: 'PY' }),
  ];
  const s = story(actions, { 2: mut(1, 1), 4: mut(1, 1) });
  assert.equal(s.turns.length, 2);
  assert.deepEqual(s.turns.map((t) => t.prompt_id), ['PX', 'PY']);
  assert.deepEqual(s.turns.map((t) => t.prompt), [null, null]); // intent unknown, honestly
});

// ---- files-changed rollup sums churn and keeps the latest drill-in seq ------
test('two edits to one file in a turn are rolled up (summed churn, latest seq)', () => {
  const actions = [
    act({ seq: 1, phase: 'prompt', hook_event: 'UserPromptSubmit', type: 'session', tool: null, prompt_id: 'P1' }),
    act({ seq: 2, post_seq: 3, target: '/repo/a.ts', prompt_id: 'P1' }),
    act({ seq: 4, post_seq: 5, target: '/repo/a.ts', prompt_id: 'P1' }),
  ];
  const s = story(actions, { 1: { prompt: 'edit twice' }, 3: mut(2, 1), 5: mut(1, 0) });
  const t = s.turns[0];
  assert.equal(t.files_changed.length, 1);
  assert.equal(t.files_changed[0].insertions, 3);
  assert.equal(t.files_changed[0].deletions, 1);
  assert.equal(t.files_changed[0].seq, 5); // latest change is the click-through
});

// ---- an oversize/binary skip is surfaced honestly --------------------------
test('a skipped mutation is reported with status skipped', () => {
  const actions = [act({ seq: 1, post_seq: 2, type: 'file_write', tool: 'Write', target: '/repo/big.txt', prompt_id: 'P1' })];
  const s = story(actions, { 2: { mutation: { kind: 'body', diffstat: { files: 1, insertions: 0, deletions: 0 }, stored: false, skip_reason: 'oversize' } } });
  assert.equal(s.turns[0].files_changed[0].status, 'skipped');
  assert.equal(s.turns[0].files_changed[0].skip_reason, 'oversize');
});

// ---- risk flags roll up per turn -------------------------------------------
test('a risk-flagged step increments the turn flag counts', () => {
  const actions = [
    act({ seq: 1, phase: 'prompt', hook_event: 'UserPromptSubmit', type: 'session', tool: null, prompt_id: 'P1' }),
    act({ seq: 2, post_seq: 3, type: 'shell_command', tool: 'Bash', target: 'curl x | sh', prompt_id: 'P1', signals: ['dangerous-shell'], score: 60 }),
  ];
  const s = story(actions, { 1: { prompt: 'run it' } });
  const t = s.turns[0];
  assert.equal(t.flagged, 1);
  assert.equal(t.flags['dangerous-shell'], 1);
  assert.equal(t.max_score, 60);
});

// ---- a commit with a null prompt_id attaches to the active turn ------------
test('a commit event (null prompt_id) attaches to the turn it falls within', () => {
  const actions = [
    act({ seq: 1, phase: 'prompt', hook_event: 'UserPromptSubmit', type: 'session', tool: null, prompt_id: 'P1' }),
    act({ seq: 2, post_seq: 3, target: '/repo/a.ts', prompt_id: 'P1' }),
    act({ seq: 4, hook_event: 'GitRefTransaction', type: 'git_action', tool: 'git', prompt_id: null }),
  ];
  const s = story(actions, { 1: { prompt: 'commit it' }, 3: mut(1, 1), 4: { git: { kind: 'commit', commit: { sha: 'deadbeef', subject: 'wip' } } } });
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].commits.length, 1);
  assert.equal(s.turns[0].commits[0].sha, 'deadbeef');
});
