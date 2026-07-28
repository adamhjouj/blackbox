'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  adaptGeminiHook,
  GeminiCorrelator,
  geminiToolFailed,
  mapGeminiToolName,
  UnsupportedGeminiHookEventError,
} = require('../dist/adapters/gemini.js');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { RiskEngine } = require('../dist/risk-engine.js');

const AT = '2026-07-28T10:00:00.000Z';
const base = (event, extra = {}) => ({
  hook_event_name: event,
  session_id: 'gemini-session',
  transcript_path: '/tmp/gemini.json',
  cwd: '/repo',
  timestamp: AT,
  ...extra,
});

function ids() {
  let n = 0;
  return () => `generated-${++n}`;
}

test('Gemini lifecycle and agent hooks map to the shared normalizer vocabulary', () => {
  const c = new GeminiCorrelator({ idFactory: ids() });
  const cases = [
    ['SessionStart', 'SessionStart', 'session_start', { source: 'startup' }],
    ['BeforeAgent', 'UserPromptSubmit', 'prompt', { prompt: 'fix auth' }],
    ['Notification', 'Notification', 'notify', { notification_type: 'ToolPermission', message: 'approval', details: { file_path: '/x' } }],
    ['PreCompress', 'PreCompact', 'compact', { trigger: 'auto' }],
    ['AfterAgent', 'Stop', 'stop', { prompt: 'fix auth', prompt_response: 'done', stop_hook_active: false }],
    ['SessionEnd', 'SessionEnd', 'session_end', { reason: 'exit' }],
  ];
  for (const [geminiEvent, sharedEvent, phase, extra] of cases) {
    const adapted = adaptGeminiHook(base(geminiEvent, extra), c);
    assert.equal(adapted.source, 'gemini-cli');
    assert.equal(adapted.payload.hook_event_name, sharedEvent);
    assert.equal(adapted.payload._gemini_event_name, geminiEvent);
    assert.equal(normalizeAndCapture(adapted.payload, AT).event.phase, phase);
  }
});

test('BeforeAgent creates a prompt id reused through tool calls and AfterAgent', () => {
  const c = new GeminiCorrelator({ idFactory: ids() });
  adaptGeminiHook(base('SessionStart'), c);
  const beforeAgent = adaptGeminiHook(base('BeforeAgent', { prompt: 'ship it' }), c);
  const beforeTool = adaptGeminiHook(base('BeforeTool', { tool_name: 'read_file', tool_input: { file_path: '/repo/a.ts' } }), c);
  const afterAgent = adaptGeminiHook(base('AfterAgent', { prompt: 'ship it', prompt_response: 'done' }), c);
  assert.equal(beforeAgent.payload.prompt_id, 'generated-1');
  assert.equal(beforeTool.payload.prompt_id, 'generated-1');
  assert.equal(afterAgent.payload.prompt_id, 'generated-1');
  assert.equal(c.currentPrompt('gemini-session'), null);
});

test('tool names map to existing action classifiers, including MCP', () => {
  assert.equal(mapGeminiToolName('run_shell_command'), 'Bash');
  assert.equal(mapGeminiToolName('read_file'), 'Read');
  assert.equal(mapGeminiToolName('write_file'), 'Write');
  assert.equal(mapGeminiToolName('replace'), 'Edit');
  assert.equal(mapGeminiToolName('mcp_github_create_issue'), 'mcp__github__create_issue');
  assert.equal(mapGeminiToolName('mcp_github_create_issue_comment'), 'mcp__github__create_issue_comment');
  assert.equal(mapGeminiToolName('mcp_incomplete'), 'mcp_incomplete');
  assert.equal(mapGeminiToolName('future_tool'), 'future_tool');

  const c = new GeminiCorrelator({ idFactory: ids() });
  const shell = adaptGeminiHook(base('BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: 'git status' } }), c);
  const mcp = adaptGeminiHook(base('BeforeTool', { tool_name: 'mcp_github_create_issue', tool_input: { title: 'x' } }), c);
  assert.equal(normalizeAndCapture(shell.payload, AT).event.action_type, 'git_action');
  const mcpEvent = normalizeAndCapture(mcp.payload, AT).event;
  assert.equal(mcpEvent.action_type, 'mcp_call');
  assert.equal(mcpEvent.tool_name, 'mcp__github__create_issue');
});

test('Gemini MCP identity survives normalization into tool-poisoning correlation', () => {
  const c = new GeminiCorrelator({ idFactory: ids() });
  const inputs = [
    ['read_file', { file_path: '/app/.env' }],
    ['mcp_evil_upload', { note: 'first contact' }],
    ['mcp_evil_upload', { file_path: '/app/.env' }],
  ];
  const events = inputs.map(([tool_name, tool_input], index) => {
    const adapted = adaptGeminiHook(base('BeforeTool', { tool_name, tool_input }), c);
    return { ...normalizeAndCapture(adapted.payload, AT).event, seq: index + 1 };
  });
  const engine = new RiskEngine(undefined, 'r2');
  let verdict;
  for (const event of events) verdict = engine.score(event).verdict;
  const poisoning = verdict.combos.find((combo) => combo.id === 'tool-poisoning');
  assert.equal(events[1].tool_name, 'mcp__evil__upload');
  assert.equal(poisoning?.severity, 'high');
  assert.equal(poisoning?.server, 'evil');
});

test('BeforeTool/AfterTool correlate FIFO by canonical tool input despite key ordering', () => {
  const c = new GeminiCorrelator({ idFactory: ids() });
  const pre1 = adaptGeminiHook(base('BeforeTool', { tool_name: 'replace', tool_input: { file_path: '/repo/a', old_string: 'a', new_string: 'b' } }), c);
  const pre2 = adaptGeminiHook(base('BeforeTool', { tool_name: 'replace', tool_input: { new_string: 'b', old_string: 'a', file_path: '/repo/a' } }), c);
  const post1 = adaptGeminiHook(base('AfterTool', { tool_name: 'replace', tool_input: { old_string: 'a', file_path: '/repo/a', new_string: 'b' }, tool_response: { llmContent: 'ok' } }), c);
  const post2 = adaptGeminiHook(base('AfterTool', { tool_name: 'replace', tool_input: { file_path: '/repo/a', new_string: 'b', old_string: 'a' }, tool_response: { returnDisplay: 'ok' } }), c);
  assert.equal(pre1.correlation, 'allocated');
  assert.equal(pre2.correlation, 'allocated');
  assert.equal(post1.correlation, 'matched');
  assert.equal(post2.correlation, 'matched');
  assert.equal(post1.payload.tool_use_id, pre1.payload.tool_use_id);
  assert.equal(post2.payload.tool_use_id, pre2.payload.tool_use_id);
  assert.equal(c.pendingCount('gemini-session'), 0);
});

test('unmatched or evicted AfterTool is explicit and never fabricates a join', () => {
  const c = new GeminiCorrelator({ idFactory: ids(), maxPendingPerSession: 1 });
  const old = adaptGeminiHook(base('BeforeTool', { tool_name: 'read_file', tool_input: { file_path: '/old' } }), c);
  adaptGeminiHook(base('BeforeTool', { tool_name: 'read_file', tool_input: { file_path: '/new' } }), c);
  const post = adaptGeminiHook(base('AfterTool', { tool_name: 'read_file', tool_input: { file_path: '/old' }, tool_response: {} }), c);
  assert.ok(old.payload.tool_use_id);
  assert.equal(post.correlation, 'unmatched');
  assert.equal(post.payload.tool_use_id, null);
  assert.equal(post.payload._blackbox_correlation, 'unmatched');
});

test('correlator bounds sessions and expires pending calls', () => {
  let now = 100;
  const c = new GeminiCorrelator({ idFactory: ids(), maxSessions: 2, pendingTtlMs: 10, now: () => now });
  c.allocateTool('s1', 'read_file', { file_path: '/a' });
  c.allocateTool('s2', 'read_file', { file_path: '/b' });
  c.allocateTool('s3', 'read_file', { file_path: '/c' });
  assert.equal(c.sessionCount(), 2);
  assert.equal(c.pendingCount('s1'), 0);
  now = 111;
  assert.equal(c.completeTool('s2', 'read_file', { file_path: '/b' }), null);
});

test('AfterTool error maps to failure and successful response maps to post', () => {
  assert.equal(geminiToolFailed({ error: 'permission denied' }), true);
  assert.equal(geminiToolFailed({ error: null }), false);
  assert.equal(geminiToolFailed({ llmContent: 'ok' }), false);
  const c = new GeminiCorrelator({ idFactory: ids() });
  adaptGeminiHook(base('BeforeTool', { tool_name: 'write_file', tool_input: { file_path: '/x', content: 'x' } }), c);
  const adapted = adaptGeminiHook(base('AfterTool', { tool_name: 'write_file', tool_input: { file_path: '/x', content: 'x' }, tool_response: { error: 'denied' } }), c);
  const event = normalizeAndCapture(adapted.payload, AT).event;
  assert.equal(adapted.payload.hook_event_name, 'PostToolUseFailure');
  assert.equal(event.phase, 'failure');
  assert.equal(event.success, 0);
});

test('adapter keeps secret-bearing Gemini fields on redactor-walked paths', () => {
  const secret = 'sk-' + 'A9bC'.repeat(12);
  const c = new GeminiCorrelator({ idFactory: ids() });
  const notice = adaptGeminiHook(base('Notification', { message: 'token=' + secret, details: { auth: 'Bearer ' + secret } }), c);
  const noticeEvent = normalizeAndCapture(notice.payload, AT).event;
  assert.equal(noticeEvent.raw.includes(secret), false);
  assert.ok(noticeEvent.redaction_count >= 1);

  const afterAgent = adaptGeminiHook(base('AfterAgent', { prompt_response: 'api_key=' + secret }), c);
  const stopEvent = normalizeAndCapture(afterAgent.payload, AT).event;
  assert.equal(stopEvent.raw.includes(secret), false);
  assert.ok(stopEvent.redaction_count >= 1);
  assert.equal(stopEvent.raw.includes('prompt_response'), false);
});

test('adapter rejects undocumented events instead of inventing a mapping', () => {
  const c = new GeminiCorrelator();
  assert.throws(() => adaptGeminiHook(base('AfterModel'), c), UnsupportedGeminiHookEventError);
});
