import { randomUUID } from 'node:crypto';
import { canonical, hashString } from './hash';
import { redact, type RedactOptions } from './redact';
import type { ActionType, NormalizedEvent, Phase } from './types';

/** Map a raw hook_event_name to our coarse phase. */
function toPhase(hookEvent: string): Phase {
  switch (hookEvent) {
    case 'SessionStart':
      return 'session_start';
    case 'PreToolUse':
      return 'pre';
    case 'PostToolUse':
      return 'post';
    case 'PostToolUseFailure':
      return 'failure';
    case 'Stop':
      return 'stop';
    case 'SessionEnd':
      return 'session_end';
    default:
      return 'other';
  }
}

/** Classify an action from its tool name + input. */
function toActionType(toolName: string | null, input: Record<string, unknown>): ActionType {
  if (!toolName) return 'session';
  if (toolName.startsWith('mcp__')) return 'mcp_call';
  const cmd = typeof input.command === 'string' ? input.command : '';
  switch (toolName) {
    case 'Bash':
      return /^\s*(sudo\s+)?git\b/.test(cmd) ? 'git_action' : 'shell_command';
    case 'Write':
      return 'file_write';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'file_edit';
    case 'Read':
      return 'file_read';
    case 'WebFetch':
    case 'WebSearch':
      return 'web_fetch';
    case 'Task':
    case 'Agent':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskStop':
      return 'task_control';
    default:
      return 'other';
  }
}

const MAX_TARGET = 500;

/** Truncate on code-point boundaries so an astral char (emoji) is never split
 *  into a lone surrogate — splitting one would both corrupt the display string
 *  and, after a SQLite UTF-8 round-trip, break the hash chain verification. */
function truncate(s: string): string {
  const points = Array.from(s);
  return points.length > MAX_TARGET ? points.slice(0, MAX_TARGET).join('') + '…' : s;
}

/** Extract a concise, human-facing target string. */
function toTarget(
  action: ActionType,
  input: Record<string, unknown>,
): string | null {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);
  switch (action) {
    case 'file_read':
    case 'file_write':
    case 'file_edit':
      return str('file_path') ? truncate(str('file_path')!) : null;
    case 'shell_command':
    case 'git_action':
      return str('command') ? truncate(str('command')!.trim()) : null;
    case 'web_fetch':
      return str('url') ?? str('query');
    case 'mcp_call':
      return Object.keys(input).length ? truncate(JSON.stringify(input)) : null;
    default:
      return null;
  }
}

/** Tolerant timing parse: live payloads use `duration_ms`; docs describe `duration` (seconds). */
function toDurationMs(payload: Record<string, unknown>): number | null {
  if (typeof payload.duration_ms === 'number') return payload.duration_ms;
  if (typeof payload.duration === 'number') return Math.round(payload.duration * 1000);
  return null;
}

function toSuccess(phase: Phase): 0 | 1 | null {
  if (phase === 'post') return 1;
  if (phase === 'failure') return 0;
  return null;
}

/**
 * Normalize one raw hook payload into a NormalizedEvent.
 *
 * Redaction runs FIRST: `raw` stores the REDACTED payload (never verbatim — a
 * security tool must not write secrets to disk), tool output is elided to a hash
 * (`output_hash`/`output_size_bytes`) unless `opts.captureOutput`, and `target`
 * is derived from the redacted input so a secret in a command/path can't leak
 * into a plain column. `capturedAt` is the ingest time (ISO).
 */
export function normalize(
  payload: Record<string, unknown>,
  capturedAt: string,
  opts: RedactOptions = {},
): NormalizedEvent {
  const hookEvent = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'Unknown';
  const phase = toPhase(hookEvent);
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;

  // Hash the ORIGINAL output before anything is redacted/elided, so we can prove
  // "this is what the agent saw" without storing the body.
  const outputVal = payload.tool_response ?? payload.tool_output;
  let output_hash: string | null = null;
  let output_size_bytes: number | null = null;
  if (outputVal !== undefined) {
    const s = canonical(outputVal);
    output_hash = hashString(s);
    output_size_bytes = Buffer.byteLength(s, 'utf8');
  }

  const { redacted, hits } = redact(payload, opts);

  // Default: elide the output body entirely (keep only the hash). Opt-in keeps
  // the already-secret-scrubbed body.
  if (!opts.captureOutput) {
    if ('tool_response' in redacted)
      redacted.tool_response = { _blackbox: 'elided', hash: output_hash, bytes: output_size_bytes };
    if ('tool_output' in redacted)
      redacted.tool_output = { _blackbox: 'elided', hash: output_hash, bytes: output_size_bytes };
  }

  const redactedInput =
    redacted.tool_input && typeof redacted.tool_input === 'object'
      ? (redacted.tool_input as Record<string, unknown>)
      : {};
  const action = toActionType(toolName, redactedInput);

  const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);

  return {
    event_id: randomUUID(),
    session_id: str('session_id') ?? 'unknown',
    tool_use_id: str('tool_use_id'),
    prompt_id: str('prompt_id'),
    phase,
    hook_event: hookEvent,
    tool_name: toolName,
    action_type: action,
    target: toTarget(action, redactedInput),
    agent_id: str('agent_id'),
    agent_type: str('agent_type') ?? (str('agent_id') ? 'unknown' : 'main'),
    cwd: str('cwd'),
    permission_mode: str('permission_mode'),
    success: toSuccess(phase),
    duration_ms: toDurationMs(payload),
    // Prefer a capture stamp already on the payload (fixtures carry `_captured_at`);
    // real HTTP hooks have none, so fall back to ingest time.
    ts: str('_captured_at') ?? capturedAt,
    captured_at: capturedAt,
    raw: JSON.stringify(redacted),
    output_hash,
    output_size_bytes,
    redaction_count: hits.length,
    detail: hits.length ? JSON.stringify({ redaction: hits.map(({ type, path, bytes }) => ({ type, path, bytes })) }) : null,
  };
}
