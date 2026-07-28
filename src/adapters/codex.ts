import type { AdaptedHookInput, NormalizerInput } from './types';

/** Codex CLI lifecycle hooks recorded by the first-party adapter. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];
export type CodexToolOutcome = 'succeeded' | 'failed' | 'unknown';

export interface CodexHookInput extends Record<string, unknown> {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  model?: unknown;
  turn_id?: unknown;
  permission_mode?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function meaningfulError(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== '';
}

export function mapCodexToolName(name: string): string {
  if (name === 'apply_patch') return 'Edit';
  if (name === 'spawn_agent') return 'Agent';
  return name;
}

/**
 * Read only explicit outcome signals from Codex's tool response. Codex emits
 * PostToolUse for non-zero shell exits too, so treating every PostToolUse as a
 * success would corrupt Blackbox verdicts. Unknown shapes remain unknown.
 */
export function codexToolOutcome(response: unknown): CodexToolOutcome {
  const value = record(response);
  for (const key of ['success', 'ok'] as const) {
    if (typeof value[key] === 'boolean') return value[key] ? 'succeeded' : 'failed';
  }
  for (const key of ['isError', 'is_error'] as const) {
    if (typeof value[key] === 'boolean') return value[key] ? 'failed' : 'succeeded';
  }
  for (const key of ['exit_code', 'exitCode'] as const) {
    if (typeof value[key] === 'number' && Number.isInteger(value[key])) {
      return value[key] === 0 ? 'succeeded' : 'failed';
    }
  }
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : null;
  if (status && ['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (status && ['ok', 'success', 'succeeded', 'completed'].includes(status)) return 'succeeded';
  if (Object.prototype.hasOwnProperty.call(value, 'error') && meaningfulError(value.error)) return 'failed';
  return 'unknown';
}

export class UnsupportedCodexHookEventError extends Error {
  constructor(event: unknown) {
    super(`unsupported Codex hook event: ${typeof event === 'string' ? event : '<missing>'}`);
    this.name = 'UnsupportedCodexHookEventError';
  }
}

function isCodexHookEvent(value: unknown): value is CodexHookEvent {
  return typeof value === 'string' && (CODEX_HOOK_EVENTS as readonly string[]).includes(value);
}

function baseInput(input: CodexHookInput, mappedEvent: string): NormalizerInput {
  const payload: NormalizerInput = {
    hook_event_name: mappedEvent,
    session_id: string(input.session_id) ?? 'unknown',
    _blackbox_adapter: 'codex-cli',
    _codex_event_name: input.hook_event_name,
  };
  for (const key of ['transcript_path', 'cwd', 'model', 'permission_mode'] as const) {
    const value = string(input[key]);
    if (value) payload[key] = value;
  }
  const turnId = string(input.turn_id);
  if (turnId) {
    payload.turn_id = turnId;
    payload.prompt_id = turnId;
  }
  return payload;
}

/** Translate one Codex stdin hook payload to the shared normalizer input. */
export function adaptCodexHook(input: CodexHookInput): AdaptedHookInput {
  const originalEvent = input.hook_event_name;
  if (!isCodexHookEvent(originalEvent)) throw new UnsupportedCodexHookEventError(originalEvent);

  let payload: NormalizerInput;
  switch (originalEvent) {
    case 'SessionStart':
      payload = baseInput(input, 'SessionStart');
      if (typeof input.source === 'string') payload.codex_session_source = input.source;
      break;

    case 'SessionEnd':
      payload = baseInput(input, 'SessionEnd');
      if (typeof input.reason === 'string') payload.reason = input.reason;
      break;

    case 'UserPromptSubmit':
      payload = baseInput(input, 'UserPromptSubmit');
      if (typeof input.prompt === 'string') payload.prompt = input.prompt;
      break;

    case 'PreToolUse': {
      payload = baseInput(input, 'PreToolUse');
      const originalToolName = string(input.tool_name) ?? 'unknown';
      payload.tool_name = mapCodexToolName(originalToolName);
      payload.tool_input = record(input.tool_input);
      payload.tool_use_id = string(input.tool_use_id);
      payload._codex_tool_name = originalToolName;
      break;
    }

    case 'PermissionRequest': {
      payload = baseInput(input, 'PermissionRequest');
      const originalToolName = string(input.tool_name) ?? 'unknown';
      payload.tool_name = mapCodexToolName(originalToolName);
      payload.tool_input = record(input.tool_input);
      payload._codex_tool_name = originalToolName;
      break;
    }

    case 'PostToolUse': {
      const outcome = codexToolOutcome(input.tool_response);
      payload = baseInput(input, outcome === 'failed' ? 'PostToolUseFailure' : 'PostToolUse');
      const originalToolName = string(input.tool_name) ?? 'unknown';
      payload.tool_name = mapCodexToolName(originalToolName);
      payload.tool_input = record(input.tool_input);
      payload.tool_response = input.tool_response;
      payload.tool_use_id = string(input.tool_use_id);
      payload._codex_tool_name = originalToolName;
      payload._blackbox_success = outcome === 'succeeded' ? 1 : outcome === 'failed' ? 0 : null;
      if (outcome === 'failed' && meaningfulError(record(input.tool_response).error)) {
        payload.error = record(input.tool_response).error;
      }
      break;
    }

    case 'PreCompact':
    case 'PostCompact':
      payload = baseInput(input, originalEvent);
      if (typeof input.trigger === 'string') payload.trigger = input.trigger;
      break;

    case 'SubagentStart':
    case 'SubagentStop':
      payload = baseInput(input, originalEvent);
      if (typeof input.agent_id === 'string') payload.agent_id = input.agent_id;
      if (typeof input.agent_type === 'string') payload.agent_type = input.agent_type;
      if (typeof input.agent_transcript_path === 'string') payload.agent_transcript_path = input.agent_transcript_path;
      if (typeof input.stop_hook_active === 'boolean') payload.stop_hook_active = input.stop_hook_active;
      if (typeof input.last_assistant_message === 'string') payload.last_assistant_message = input.last_assistant_message;
      break;

    case 'Stop':
      payload = baseInput(input, 'Stop');
      if (typeof input.stop_hook_active === 'boolean') payload.stop_hook_active = input.stop_hook_active;
      if (typeof input.last_assistant_message === 'string') payload.last_assistant_message = input.last_assistant_message;
      break;
  }

  return { source: 'codex-cli', original_event: originalEvent, correlation: 'not-applicable', payload };
}
