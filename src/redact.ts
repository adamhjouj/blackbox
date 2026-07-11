import { hashString } from './hash';
import { isSensitivePath, PREFIX_RULES, type SecretType } from './redact-rules';

export interface RedactionHit {
  type: SecretType;
  /** Dot-path within the payload, e.g. "tool_input.command". */
  path: string;
  /** sha256 of the exact removed value — proves coverage without storing it. */
  hash: string;
  bytes: number;
}

export interface RedactOptions {
  /** Keep tool output body (still secret-scrubbed) instead of eliding to a hash. Default false. */
  captureOutput?: boolean;
  /** Minimum token length for entropy detection. Default 24. */
  entropyMinLen?: number;
  /** Minimum Shannon bits/char for entropy detection. Default 3.5. */
  entropyMinBits?: number;
}

export interface RedactionResult {
  redacted: Record<string, unknown>;
  hits: RedactionHit[];
}

/** Only these subtrees are walked. Top-level IDs (session_id, tool_use_id, …) are
 *  deliberately left untouched — entropy detection would wreck columns and joins. */
const WALK_FIELDS = ['tool_input', 'tool_response', 'tool_output', 'error', 'last_assistant_message'];

const PLACEHOLDER = (t: SecretType) => `[REDACTED:${t}]`;

function record(hits: RedactionHit[], type: SecretType, path: string, value: string): void {
  hits.push({ type, path, hash: hashString(value), bytes: Buffer.byteLength(value, 'utf8') });
}

function shannonBits(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Heuristic: does this token look like a credential rather than a hash/uuid/id/path? */
function isLikelySecret(tok: string, minLen: number, minBits: number): boolean {
  if (tok.length < minLen) return false;
  if (/^[0-9a-f]{7,64}$/i.test(tok)) return false; // hex digest / git sha
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok)) return false; // uuid
  if (/^\d+$/.test(tok)) return false; // pure number
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/].filter((re) => re.test(tok)).length;
  if (classes < 2) return false; // credentials mix character classes
  return shannonBits(tok) >= minBits;
}

/** Redact one string: known prefixes first, then an entropy sweep of the residual. */
function redactString(s: string, path: string, hits: RedactionHit[], opts: RedactOptions): string {
  let out = s;
  for (const rule of PREFIX_RULES) {
    out = out.replace(rule.re, (m) => {
      record(hits, rule.type, path, m);
      return PLACEHOLDER(rule.type);
    });
  }
  const minLen = opts.entropyMinLen ?? 24;
  const minBits = opts.entropyMinBits ?? 3.5;
  // Token charset excludes the path/URL separators '/', '.', and '-' so
  // slash/dot/dash-delimited paths (incl. macOS's dash-encoded scratch paths)
  // are never mistaken for base64 blobs; a contiguous secret still leaves a long
  // run. Trade-off: an unknown secret split by one of those chars may only be
  // partially caught by the entropy net — prefix + path rules cover the high-value cases.
  out = out.replace(/[A-Za-z0-9+_=]{24,}/g, (tok) => {
    if (!isLikelySecret(tok, minLen, minBits)) return tok;
    record(hits, 'high-entropy', path, tok);
    return PLACEHOLDER('high-entropy');
  });
  return out;
}

function walk(value: unknown, path: string, hits: RedactionHit[], opts: RedactOptions): unknown {
  if (typeof value === 'string') return redactString(value, path, hits, opts);
  if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, hits, opts));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = walk(obj[k], `${path}.${k}`, hits, opts);
    return out;
  }
  return value;
}

/** Drop the CONTENT of a sensitive-path read/write to a hash, regardless of entropy. */
function applyPathRules(payload: Record<string, unknown>, hits: RedactionHit[]): void {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const filePath = input && typeof input.file_path === 'string' ? input.file_path : null;
  if (filePath && isSensitivePath(filePath) && typeof input!.content === 'string') {
    record(hits, 'path-sensitive-content', 'tool_input.content', input!.content as string);
    input!.content = PLACEHOLDER('path-sensitive-content');
  }
  // Read result: tool_response.file.content with a sensitive filePath.
  const resp = payload.tool_response as Record<string, unknown> | undefined;
  const file = resp && typeof resp.file === 'object' ? (resp.file as Record<string, unknown>) : null;
  const respPath = file && typeof file.filePath === 'string' ? (file.filePath as string) : null;
  if (respPath && isSensitivePath(respPath) && typeof file!.content === 'string') {
    record(hits, 'path-sensitive-content', 'tool_response.file.content', file!.content as string);
    file!.content = PLACEHOLDER('path-sensitive-content');
  }
}

/**
 * Redact secrets from a hook payload BEFORE it is stored. Deep-clones the input,
 * so the caller's object is untouched. Fail-closed: if a subtree redaction throws,
 * that whole field is dropped to a hash rather than stored raw.
 */
export function redact(payload: Record<string, unknown>, opts: RedactOptions = {}): RedactionResult {
  const hits: RedactionHit[] = [];
  const redacted = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  try {
    applyPathRules(redacted, hits);
  } catch {
    // Path rules are best-effort; the per-field walk below is the safety net.
  }

  for (const field of WALK_FIELDS) {
    if (!(field in redacted)) continue;
    try {
      redacted[field] = walk(redacted[field], field, hits, opts);
    } catch {
      const original = JSON.stringify(payload[field] ?? null);
      redacted[field] = PLACEHOLDER('redactor-error');
      record(hits, 'redactor-error', field, original);
    }
  }

  return { redacted, hits };
}
