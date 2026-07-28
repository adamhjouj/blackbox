'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CODEX_HOOK_EVENTS,
  UnsupportedCodexHookEventError,
  adaptCodexHook,
  codexToolOutcome,
  mapCodexToolName,
} = require('../dist/adapters/codex.js');
const { normalizeAndCapture } = require('../dist/normalize.js');

const AT = '2026-07-29T00:00:00.000Z';
const base = (hook_event_name, extra = {}) => ({
  hook_event_name,
  session_id: 'thr_123',
  turn_id: 'turn_456',
  cwd: '/repo',
  model: 'gpt-test',
  permission_mode: 'default',
  ...extra,
});

test('Codex adapter declares the current supported lifecycle surface', () => {
  assert.deepEqual(CODEX_HOOK_EVENTS, [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
    'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
    'SubagentStart', 'SubagentStop', 'Stop',
  ]);
});

test('Codex adapter preserves stable session, turn, and tool correlation ids', () => {
  const adapted = adaptCodexHook(base('PreToolUse', {
    tool_name: 'Bash',
    tool_use_id: 'call_789',
    tool_input: { command: 'printf ok' },
  }));
  assert.equal(adapted.source, 'codex-cli');
  assert.equal(adapted.payload.session_id, 'thr_123');
  assert.equal(adapted.payload.prompt_id, 'turn_456');
  assert.equal(adapted.payload.tool_use_id, 'call_789');
  assert.equal(adapted.payload.tool_name, 'Bash');

  const event = normalizeAndCapture(adapted.payload, AT).event;
  assert.equal(event.source, 'codex-cli');
  assert.equal(event.phase, 'pre');
  assert.equal(event.action_type, 'shell_command');
  assert.equal(event.target, 'printf ok');
});

test('Codex tool aliases map to the shared action vocabulary', () => {
  assert.equal(mapCodexToolName('apply_patch'), 'Edit');
  assert.equal(mapCodexToolName('spawn_agent'), 'Agent');
  assert.equal(mapCodexToolName('mcp__server__tool'), 'mcp__server__tool');
});

test('Codex post-tool outcomes use explicit evidence and keep ambiguity unknown', () => {
  assert.equal(codexToolOutcome({ success: true }), 'succeeded');
  assert.equal(codexToolOutcome({ exit_code: 17 }), 'failed');
  assert.equal(codexToolOutcome({ isError: true }), 'failed');
  assert.equal(codexToolOutcome({ output: 'completed but no status field' }), 'unknown');

  const failed = normalizeAndCapture(adaptCodexHook(base('PostToolUse', {
    tool_name: 'Bash', tool_use_id: 'fail-1', tool_input: { command: 'false' },
    tool_response: { exit_code: 1, error: 'command failed' },
  })).payload, AT).event;
  assert.equal(failed.hook_event, 'PostToolUseFailure');
  assert.equal(failed.phase, 'failure');
  assert.equal(failed.success, 0);

  const succeeded = normalizeAndCapture(adaptCodexHook(base('PostToolUse', {
    tool_name: 'Bash', tool_use_id: 'ok-1', tool_input: { command: 'true' },
    tool_response: { exit_code: 0 },
  })).payload, AT).event;
  assert.equal(succeeded.success, 1);

  const unknown = normalizeAndCapture(adaptCodexHook(base('PostToolUse', {
    tool_name: 'Bash', tool_use_id: 'unknown-1', tool_input: { command: 'custom' },
    tool_response: { output: 'opaque' },
  })).payload, AT).event;
  assert.equal(unknown.phase, 'post');
  assert.equal(unknown.success, null);
});

test('Codex prompts, compaction, and subagent lifecycle normalize without schema changes', () => {
  const prompt = normalizeAndCapture(adaptCodexHook(base('UserPromptSubmit', { prompt: 'Review this patch' })).payload, AT).event;
  assert.equal(prompt.phase, 'prompt');
  assert.equal(prompt.prompt_id, 'turn_456');
  assert.match(prompt.detail, /Review this patch/);

  const compact = normalizeAndCapture(adaptCodexHook(base('PostCompact', { trigger: 'auto' })).payload, AT).event;
  assert.equal(compact.phase, 'compact');

  const subagent = normalizeAndCapture(adaptCodexHook(base('SubagentStart', { agent_id: 'agent_1', agent_type: 'reviewer' })).payload, AT).event;
  assert.equal(subagent.agent_id, 'agent_1');
  assert.equal(subagent.agent_type, 'reviewer');
});

test('Codex adapter sends every sensitive field through shared redaction', () => {
  const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz123456';
  const adapted = adaptCodexHook(base('PostToolUse', {
    tool_name: 'mcp__example__call',
    tool_use_id: 'secret-1',
    tool_input: { token: secret },
    tool_response: { success: false, error: `Bearer ${secret}` },
  }));
  const event = normalizeAndCapture(adapted.payload, AT).event;
  assert.equal(event.raw.includes(secret), false);
  assert.ok(event.redaction_count >= 1);
});

test('Codex adapter rejects unknown events rather than inventing evidence', () => {
  assert.throws(() => adaptCodexHook(base('Notification')), UnsupportedCodexHookEventError);
});
