/**
 * The canonical event schema — the single normalized shape every part of
 * blackbox reads and writes. One row per hook event; Pre/Post/Failure phases
 * of the same action are separate rows joined by `tool_use_id`.
 *
 * Design rule (from Day-1 findings): the verbatim hook payload is always kept
 * in `raw`, and normalized columns are derived from it with a tolerant parser.
 * A future Claude Code field rename degrades a normalized column, never the
 * `raw` record — so we never lose data.
 */

export type Phase =
  | 'session_start'
  | 'pre'
  | 'post'
  | 'failure'
  | 'stop'
  | 'session_end'
  | 'other';

export type ActionType =
  | 'shell_command'
  | 'git_action'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'mcp_call'
  | 'web_fetch'
  | 'task_control'
  | 'session'
  | 'other';

/** A fully persisted event, including its chain fields. */
export interface BlackboxEvent {
  /** Monotonic chain position, assigned by the store (1-based). */
  seq: number;
  /** Stable unique id for this event row. */
  event_id: string;
  session_id: string;
  /** Join key between Pre (intent) and Post/Failure (result); null for session events. */
  tool_use_id: string | null;
  /** Groups actions by user turn. */
  prompt_id: string | null;
  phase: Phase;
  /** Verbatim `hook_event_name` (PreToolUse, PostToolUse, ...). */
  hook_event: string;
  tool_name: string | null;
  action_type: ActionType;
  /** Human-facing target: file path, command, url, or arg summary. */
  target: string | null;
  agent_id: string | null;
  /** 'main' for the top-level agent; the subagent name otherwise. */
  agent_type: string | null;
  cwd: string | null;
  permission_mode: string | null;
  /** 1 = success, 0 = failure, null = not applicable (pre / session). */
  success: 0 | 1 | null;
  duration_ms: number | null;
  /** Event time (ISO). Falls back to captured_at when the payload has none. */
  ts: string;
  /** When blackbox ingested the event (ISO). */
  captured_at: string;
  /** The verbatim payload, exactly as received. */
  raw: string;
  /** Hash of the previous event (GENESIS for the first). */
  prev_hash: string;
  /** sha256 over all columns except this one. */
  hash: string;
}

/** An event before the store assigns its chain fields. */
export type NormalizedEvent = Omit<BlackboxEvent, 'seq' | 'prev_hash' | 'hash'>;

/**
 * Column order of the `events` table. The hash covers every column except
 * `hash` itself — declared once here so append and verify can never drift.
 */
export const EVENT_COLUMNS = [
  'seq',
  'event_id',
  'session_id',
  'tool_use_id',
  'prompt_id',
  'phase',
  'hook_event',
  'tool_name',
  'action_type',
  'target',
  'agent_id',
  'agent_type',
  'cwd',
  'permission_mode',
  'success',
  'duration_ms',
  'ts',
  'captured_at',
  'raw',
  'prev_hash',
  'hash',
] as const;
