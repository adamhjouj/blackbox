/**
 * Adapter boundary for agent hook integrations.
 *
 * Adapters translate a vendor's hook payload into the tolerant input shape that
 * `normalizeAndCapture()` already accepts. Keeping this boundary independent of
 * the persisted event schema means a vendor field rename can degrade one
 * projection without changing, or bypassing, Blackbox's shared redaction path.
 */

export type AdapterSource = 'claude-code' | 'gemini-cli' | 'codex-cli';

/** The minimum input contract consumed by src/normalize.ts. */
export interface NormalizerInput extends Record<string, unknown> {
  hook_event_name: string;
  session_id: string;
  tool_use_id?: string | null;
  prompt_id?: string | null;
  tool_name?: string | null;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  error?: unknown;
  cwd?: string;
  _captured_at?: string;
  /** Explicit adapter outcome override. null means the vendor did not expose enough evidence. */
  _blackbox_success?: 0 | 1 | null;
  /** Adapter provenance. Kept out of vendor-owned field names such as Gemini's `source`. */
  _blackbox_adapter: AdapterSource;
}

export type AdapterCorrelation = 'allocated' | 'matched' | 'unmatched' | 'not-applicable';

export interface AdaptedHookInput {
  source: AdapterSource;
  original_event: string;
  correlation: AdapterCorrelation;
  payload: NormalizerInput;
}
