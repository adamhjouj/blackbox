import { randomUUID } from 'node:crypto';
import { canonical, hashString } from './hash';
import { outputToText, scanOutputForInjection } from './injection';
import { captureMutation, type BlobInput, type MutationFact, type SessionAnchor } from './mutation';
import { redact, redactText, type RedactOptions } from './redact';
import type { TurnIntent } from './transcript';
import type { ActionType, NormalizedEvent, Phase } from './types';

/** Map a raw hook_event_name to our coarse phase. */
function toPhase(hookEvent: string): Phase {
  switch (hookEvent) {
    case 'SessionStart':
      return 'session_start';
    case 'UserPromptSubmit':
      return 'prompt';
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
/** A user prompt is the turn's intent — worth more room than a target string, but
 *  still bounded so a pathological paste can't bloat the hashed row. Full redacted
 *  prompt survives in `raw`; this is the display projection. */
const MAX_PROMPT = 2000;
/** The agent's reasoning digest (R1) — bounded so a very long chain of thought can't
 *  bloat the hashed row. The full transcript stays on disk, read on demand for the UI. */
const MAX_REASONING = 4000;

/** Truncate on code-point boundaries so an astral char (emoji) is never split
 *  into a lone surrogate — splitting one would both corrupt the display string
 *  and, after a SQLite UTF-8 round-trip, break the hash chain verification. */
function truncate(s: string, max: number = MAX_TARGET): string {
  const points = Array.from(s);
  return points.length > max ? points.slice(0, max).join('') + '…' : s;
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

export interface NormalizeOptions extends RedactOptions {
  /** Session-level git anchor, recorded on SessionStart/SessionEnd events only. */
  anchor?: SessionAnchor | null;
}

/**
 * Normalize one raw hook payload into a NormalizedEvent. See normalizeAndCapture;
 * this thin wrapper is for callers that don't persist mutation-evidence blobs.
 */
export function normalize(
  payload: Record<string, unknown>,
  capturedAt: string,
  opts: NormalizeOptions = {},
): NormalizedEvent {
  return normalizeAndCapture(payload, capturedAt, opts).event;
}

/**
 * Normalize one raw hook payload into a NormalizedEvent AND capture any mutation
 * evidence blob to persist alongside it.
 *
 * Redaction runs FIRST: `raw` stores the REDACTED payload (never verbatim — a
 * security tool must not write secrets to disk), tool output is elided to a hash
 * (`output_hash`/`output_size_bytes`) unless `opts.captureOutput`, and `target`
 * is derived from the redacted input so a secret in a command/path can't leak
 * into a plain column. For file_write/file_edit POST events, a redacted patch/body
 * is captured: its FACT (content_hash, diffstat, …) rides in the hashed `detail`,
 * and its bytes are returned as `blob` for the store to persist un-hashed and
 * prunable. `capturedAt` is the ingest time (ISO).
 */
export function normalizeAndCapture(
  payload: Record<string, unknown>,
  capturedAt: string,
  opts: NormalizeOptions = {},
): { event: NormalizedEvent; blob: BlobInput | null } {
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

  // Capture-time fact: scan the ORIGINAL output for injection markers before it
  // is elided (it can't be recomputed later). Stored in the hashed `detail`.
  const injection = outputVal !== undefined ? scanOutputForInjection(outputToText(outputVal)) : null;

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

  // Mutation capture (file_write / file_edit POST): a small redacted patch/body,
  // content-addressed. The FACT goes into the hashed `detail`; the blob bytes are
  // returned for the store to persist in the same append transaction.
  let mutation: MutationFact | null = null;
  let blob: BlobInput | null = null;
  if (phase === 'post' && (action === 'file_write' || action === 'file_edit')) {
    const cap = captureMutation(action, redactedInput);
    if (cap) {
      mutation = cap.fact;
      blob = cap.blob;
    }
  }

  // Git anchor: recorded once per session (SessionStart/SessionEnd) so pre-session
  // file state can later be referenced from git, never copied. Computed by the
  // caller (daemon) off the per-tool path; absent for fixture ingest.
  const anchor = phase === 'session_start' || phase === 'session_end' ? opts.anchor ?? null : null;

  // The agent's own one-line description of the call (Claude Code attaches one to
  // Bash and some tools). Captured as a fact so the timeline can read in plain
  // English without re-reading the raw payload per row.
  const description = typeof redactedInput.description === 'string' ? redactedInput.description.trim() : null;

  const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);

  // The user's submitted prompt (UserPromptSubmit): the turn's intent. The field name
  // differs across Claude Code versions — the docs say `user_input`, live payloads have
  // used `prompt` — so accept either (both are in redact's WALK_FIELDS, so whichever is
  // present is scrubbed before it reaches the hashed detail; the full redacted prompt
  // also survives in `raw`).
  const promptRaw =
    typeof redacted.user_input === 'string'
      ? (redacted.user_input as string)
      : typeof redacted.prompt === 'string'
        ? (redacted.prompt as string)
        : null;
  const prompt = phase === 'prompt' && promptRaw ? truncate(promptRaw.trim(), MAX_PROMPT) : null;
  // Subagent→parent link: ties a subagent's events back to the Task/Agent call that
  // spawned it, so provenance can nest the subtree. Not a documented hook field yet —
  // captured opportunistically (null → omitted, hash-neutral); provenance falls back to
  // agent_id when it's absent.
  const parentToolUseId = str('parent_tool_use_id');

  const event: NormalizedEvent = {
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
    detail: buildDetail(hits, injection, description, mutation, anchor, prompt, parentToolUseId),
  };
  return { event, blob };
}

/** Merge the capture-time facts (redaction summary + injection scan + the agent's
 *  own description + mutation commitment + git anchor) into the hashed `detail`
 *  column. null keeps it hash-neutral; adding a key only affects the NEW event that
 *  carries it, never any already-recorded row (canonical() omits absent keys). */
function buildDetail(
  hits: { type: string; path: string; bytes: number }[],
  injection: { patterns: string[]; truncated: boolean; scanner_version: string } | null,
  description: string | null,
  mutation: MutationFact | null,
  anchor: SessionAnchor | null,
  prompt: string | null,
  parentToolUseId: string | null,
): string | null {
  const detail: Record<string, unknown> = {};
  if (hits.length) detail.redaction = hits.map(({ type, path, bytes }) => ({ type, path, bytes }));
  if (injection) detail.output_signals = { injection: injection.patterns, truncated: injection.truncated, scanner_version: injection.scanner_version };
  if (description) detail.description = description;
  if (mutation) detail.mutation = mutation;
  if (anchor) detail.anchor = anchor;
  if (prompt) detail.prompt = prompt;
  if (parentToolUseId) detail.parent_tool_use_id = parentToolUseId;
  return Object.keys(detail).length ? JSON.stringify(detail) : null;
}

/**
 * R1 — build a standalone `reasoning` event carrying the turn's captured intent:
 * a REDACTED, bounded `detail.reasoning` digest + `detail.turn_meta` (model/usage/
 * stop_reason). Appended async after Stop (off the hook path), keyed to the turn by
 * `prompt_id`. A hashed fact — durable even if the transcript later rotates. The
 * full verbatim transcript is never copied; the UI reads it on demand.
 *
 * The digest is the agent's stated words (mostly its `text` output). Redaction uses
 * the same heuristic engine as everything else — HONEST LIMIT: an un-keyed prose
 * secret ("the password is hunter2") or a URL-embedded credential can slip the
 * heuristics. Prose secrets are rarer in an assistant's explanation than in a
 * tool_input, but the UI must not present the digest as guaranteed-clean.
 */
export function reasoningEvent(sessionId: string, intent: TurnIntent, capturedAt: string): NormalizedEvent {
  const { text, hits } = redactText(intent.reasoning || '');
  const reasoning = truncate(text.trim(), MAX_REASONING);
  const detail: Record<string, unknown> = {
    turn_meta: { model: intent.model ?? null, usage: intent.usage ?? null, stop_reason: intent.stop_reason ?? null, assistant_messages: intent.assistant_messages },
  };
  if (reasoning) detail.reasoning = reasoning;
  return {
    event_id: randomUUID(),
    session_id: sessionId,
    tool_use_id: null,
    prompt_id: intent.promptId,
    phase: 'reasoning',
    hook_event: 'ReasoningCapture',
    tool_name: null,
    action_type: 'session',
    target: null,
    agent_id: null,
    agent_type: 'main',
    cwd: null,
    permission_mode: null,
    success: null,
    duration_ms: null,
    ts: capturedAt,
    captured_at: capturedAt,
    raw: JSON.stringify({ kind: 'reasoning-capture', session_id: sessionId, prompt_id: intent.promptId }),
    output_hash: null,
    output_size_bytes: null,
    redaction_count: hits.length,
    detail: JSON.stringify(detail),
  };
}
