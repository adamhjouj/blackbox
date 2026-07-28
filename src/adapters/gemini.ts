import { randomUUID } from 'node:crypto';
import { canonical } from '../hash';
import { redact } from '../redact';
import type { AdaptedHookInput, AdapterCorrelation, NormalizerInput } from './types';

/** Gemini CLI hook events intentionally captured by the first-party adapter.
 * Model hooks are excluded: AfterModel fires for streaming chunks and would add
 * high-volume model content without improving tool-boundary evidence. */
export const GEMINI_HOOK_EVENTS = [
  'SessionStart',
  'BeforeAgent',
  'BeforeTool',
  'AfterTool',
  'AfterAgent',
  'Notification',
  'PreCompress',
  'SessionEnd',
] as const;

export type GeminiHookEvent = (typeof GEMINI_HOOK_EVENTS)[number];

export interface GeminiHookInput extends Record<string, unknown> {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  timestamp?: unknown;
}

export interface GeminiCorrelatorOptions {
  /** Maximum concurrently remembered sessions. Oldest sessions are evicted. */
  maxSessions?: number;
  /** Maximum unmatched BeforeTool calls remembered per session. */
  maxPendingPerSession?: number;
  /** Drop unmatched calls older than this many milliseconds. */
  pendingTtlMs?: number;
  /** Injectable for deterministic tests. */
  idFactory?: () => string;
  /** Injectable for deterministic tests. */
  now?: () => number;
}

interface PendingCall {
  id: string;
  key: string;
  createdAt: number;
}

interface SessionState {
  promptId: string | null;
  pendingByKey: Map<string, PendingCall[]>;
  pendingOrder: PendingCall[];
}

const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_PENDING = 256;
const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? value! : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Translate Gemini tool names into the names already understood by Blackbox's
 * action classifier. Unknown names remain intact, preserving forward compatibility. */
export function mapGeminiToolName(name: string): string {
  const direct: Record<string, string> = {
    run_shell_command: 'Bash',
    read_file: 'Read',
    read_many_files: 'Read',
    write_file: 'Write',
    replace: 'Edit',
    web_fetch: 'WebFetch',
    google_web_search: 'WebSearch',
    grep_search: 'Grep',
    glob: 'Glob',
  };
  if (direct[name]) return direct[name]!;
  // Gemini documents MCP names as mcp_<server>_<tool>. The boundary between
  // server and tool is not separately supplied, so preserve the full suffix.
  // `mcp__` is Blackbox's established classifier prefix.
  if (name.startsWith('mcp_')) return `mcp__${name.slice(4)}`;
  return name;
}

/** Whether Gemini's documented AfterTool response represents a failed call. */
export function geminiToolFailed(response: unknown): boolean {
  const value = record(response);
  if (!Object.prototype.hasOwnProperty.call(value, 'error')) return false;
  const error = value.error;
  return error !== null && error !== undefined && error !== false && error !== '';
}

/**
 * Process-local correlation for Gemini, which does not expose a tool_use_id.
 *
 * Calls are joined by session + mapped tool name + canonical REDACTED input and
 * resolved FIFO within that key. Only generated ids, timestamps, and redacted
 * keys are retained. A daemon restart or eviction deliberately degrades an
 * AfterTool event to `tool_use_id: null` / `correlation: unmatched`; it never
 * fabricates a join.
 */
export class GeminiCorrelator {
  readonly maxSessions: number;
  readonly maxPendingPerSession: number;
  readonly pendingTtlMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionState>();

  constructor(opts: GeminiCorrelatorOptions = {}) {
    this.maxSessions = positiveInt(opts.maxSessions, DEFAULT_MAX_SESSIONS);
    this.maxPendingPerSession = positiveInt(opts.maxPendingPerSession, DEFAULT_MAX_PENDING);
    this.pendingTtlMs = nonNegative(opts.pendingTtlMs, DEFAULT_PENDING_TTL_MS);
    this.idFactory = opts.idFactory ?? randomUUID;
    this.now = opts.now ?? Date.now;
  }

  private freshState(): SessionState {
    return { promptId: null, pendingByKey: new Map(), pendingOrder: [] };
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = this.freshState();
      this.sessions.set(sessionId, state);
      while (this.sessions.size > this.maxSessions) {
        const oldest = this.sessions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.sessions.delete(oldest);
      }
    } else {
      // Map insertion order doubles as a small LRU, keeping active sessions.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, state);
    }
    this.expire(state);
    return state;
  }

  private expire(state: SessionState): void {
    const cutoff = this.now() - this.pendingTtlMs;
    while (state.pendingOrder.length && state.pendingOrder[0]!.createdAt < cutoff) {
      this.removePending(state, state.pendingOrder.shift()!);
    }
  }

  private removePending(state: SessionState, call: PendingCall): void {
    const queue = state.pendingByKey.get(call.key);
    if (!queue) return;
    const index = queue.indexOf(call);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) state.pendingByKey.delete(call.key);
  }

  private key(toolName: string, toolInput: Record<string, unknown>): string {
    // Never retain raw tool arguments in adapter memory. The same redactor used
    // before persistence runs before the canonical correlation key is produced.
    const scrubbed = redact({ tool_input: toolInput }).redacted.tool_input;
    return `${mapGeminiToolName(toolName)}\u0000${canonical(scrubbed ?? {})}`;
  }

  startSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.state(sessionId);
  }

  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  startPrompt(sessionId: string): string {
    const state = this.state(sessionId);
    state.promptId = this.idFactory();
    return state.promptId;
  }

  currentPrompt(sessionId: string): string | null {
    return this.state(sessionId).promptId;
  }

  finishPrompt(sessionId: string): string | null {
    const state = this.state(sessionId);
    const promptId = state.promptId;
    state.promptId = null;
    return promptId;
  }

  allocateTool(sessionId: string, toolName: string, toolInput: Record<string, unknown>): string {
    const state = this.state(sessionId);
    const call: PendingCall = { id: this.idFactory(), key: this.key(toolName, toolInput), createdAt: this.now() };
    const queue = state.pendingByKey.get(call.key) ?? [];
    queue.push(call);
    state.pendingByKey.set(call.key, queue);
    state.pendingOrder.push(call);

    while (state.pendingOrder.length > this.maxPendingPerSession) {
      this.removePending(state, state.pendingOrder.shift()!);
    }
    return call.id;
  }

  completeTool(sessionId: string, toolName: string, toolInput: Record<string, unknown>): string | null {
    const state = this.state(sessionId);
    const key = this.key(toolName, toolInput);
    const queue = state.pendingByKey.get(key);
    const call = queue?.shift() ?? null;
    if (!call) return null;
    if (!queue!.length) state.pendingByKey.delete(key);
    const orderIndex = state.pendingOrder.indexOf(call);
    if (orderIndex >= 0) state.pendingOrder.splice(orderIndex, 1);
    return call.id;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  pendingCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.pendingOrder.length ?? 0;
  }
}

export class UnsupportedGeminiHookEventError extends Error {
  constructor(event: unknown) {
    super(`unsupported Gemini hook event: ${typeof event === 'string' ? event : '<missing>'}`);
    this.name = 'UnsupportedGeminiHookEventError';
  }
}

function isGeminiHookEvent(value: unknown): value is GeminiHookEvent {
  return typeof value === 'string' && (GEMINI_HOOK_EVENTS as readonly string[]).includes(value);
}

function baseInput(input: GeminiHookInput, mappedEvent: string): NormalizerInput {
  const sessionId = string(input.session_id) ?? 'unknown';
  const payload: NormalizerInput = {
    hook_event_name: mappedEvent,
    session_id: sessionId,
    _blackbox_adapter: 'gemini-cli',
    _gemini_event_name: input.hook_event_name,
  };
  const cwd = string(input.cwd);
  const transcriptPath = string(input.transcript_path);
  const timestamp = string(input.timestamp);
  if (cwd) payload.cwd = cwd;
  if (transcriptPath) payload.transcript_path = transcriptPath;
  if (timestamp) payload._captured_at = timestamp;
  return payload;
}

function withToolContext(input: GeminiHookInput): Record<string, unknown> {
  const toolInput = { ...record(input.tool_input) };
  const mcpContext = record(input.mcp_context);
  if (Object.keys(mcpContext).length) toolInput._gemini_mcp_context = mcpContext;
  const originalRequestName = string(input.original_request_name);
  if (originalRequestName) toolInput._gemini_original_request_name = originalRequestName;
  return toolInput;
}

function correlationPayload(payload: NormalizerInput, status: AdapterCorrelation): void {
  payload._blackbox_correlation = status;
}

/** Translate one Gemini stdin hook payload to normalizeAndCapture-compatible input. */
export function adaptGeminiHook(input: GeminiHookInput, correlator: GeminiCorrelator): AdaptedHookInput {
  const originalEvent = input.hook_event_name;
  if (!isGeminiHookEvent(originalEvent)) throw new UnsupportedGeminiHookEventError(originalEvent);

  const sessionId = string(input.session_id) ?? 'unknown';
  let correlation: AdapterCorrelation = 'not-applicable';
  let payload: NormalizerInput;

  switch (originalEvent) {
    case 'SessionStart':
      correlator.startSession(sessionId);
      payload = baseInput(input, 'SessionStart');
      if (typeof input.source === 'string') payload.gemini_session_source = input.source;
      break;

    case 'BeforeAgent': {
      payload = baseInput(input, 'UserPromptSubmit');
      payload.prompt_id = correlator.startPrompt(sessionId);
      if (typeof input.prompt === 'string') payload.prompt = input.prompt;
      break;
    }

    case 'BeforeTool': {
      const geminiToolName = string(input.tool_name) ?? 'unknown';
      const toolInput = withToolContext(input);
      payload = baseInput(input, 'PreToolUse');
      payload.tool_name = mapGeminiToolName(geminiToolName);
      payload.tool_input = toolInput;
      payload.tool_use_id = correlator.allocateTool(sessionId, geminiToolName, record(input.tool_input));
      payload.prompt_id = correlator.currentPrompt(sessionId);
      payload._gemini_tool_name = geminiToolName;
      correlation = 'allocated';
      break;
    }

    case 'AfterTool': {
      const geminiToolName = string(input.tool_name) ?? 'unknown';
      const toolInput = withToolContext(input);
      const failed = geminiToolFailed(input.tool_response);
      const toolUseId = correlator.completeTool(sessionId, geminiToolName, record(input.tool_input));
      payload = baseInput(input, failed ? 'PostToolUseFailure' : 'PostToolUse');
      payload.tool_name = mapGeminiToolName(geminiToolName);
      payload.tool_input = toolInput;
      payload.tool_response = input.tool_response;
      payload.tool_use_id = toolUseId;
      payload.prompt_id = correlator.currentPrompt(sessionId);
      payload._gemini_tool_name = geminiToolName;
      if (failed) payload.error = record(input.tool_response).error;
      correlation = toolUseId ? 'matched' : 'unmatched';
      break;
    }

    case 'AfterAgent':
      payload = baseInput(input, 'Stop');
      payload.prompt_id = correlator.finishPrompt(sessionId);
      if (typeof input.prompt === 'string') payload.prompt = input.prompt;
      // `prompt_response` is not copied under its vendor field name because the
      // shared redactor walks `last_assistant_message`, not `prompt_response`.
      if (typeof input.prompt_response === 'string') payload.last_assistant_message = input.prompt_response;
      if (typeof input.stop_hook_active === 'boolean') payload.stop_hook_active = input.stop_hook_active;
      break;

    case 'Notification':
      payload = baseInput(input, 'Notification');
      if (typeof input.notification_type === 'string') payload.notification_type = input.notification_type;
      // Nest both fields under a redactor-walked key so alert details cannot
      // bypass the normal secret scrubber.
      payload.message = { summary: input.message, details: input.details };
      break;

    case 'PreCompress':
      payload = baseInput(input, 'PreCompact');
      if (typeof input.trigger === 'string') payload.trigger = input.trigger;
      break;

    case 'SessionEnd':
      payload = baseInput(input, 'SessionEnd');
      if (typeof input.reason === 'string') payload.reason = input.reason;
      correlator.endSession(sessionId);
      break;
  }

  correlationPayload(payload, correlation);
  return { source: 'gemini-cli', original_event: originalEvent, correlation, payload };
}
