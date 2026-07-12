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
const WALK_FIELDS = ['tool_input', 'tool_response', 'tool_output', 'error', 'last_assistant_message', 'prompt', 'user_input', 'message'];

/** key = value / key: value where the key names a credential — catches even
 *  low-entropy secrets (e.g. `DB_PASSWORD=hunter2`) and slash-bearing values. */
const ASSIGNMENT_RE =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|credential)s?[a-z0-9_]*["'`]?\s*[:=]\s*["'`]?([^\s"'`,;)]{6,})/gi;

/** Base64/base64url secrets often contain '/', which the path-safe entropy pass
 *  excludes. Distinguish a base64 blob from a real filesystem path. */
function isPathLike(tok: string): boolean {
  if (tok.startsWith('/') || tok.includes('./')) return true;
  const segs = tok.split('/').filter(Boolean);
  if (segs.length < 2) return false;
  const wordish = segs.filter((s) => /^[a-z][a-z0-9_]*$/.test(s)).length;
  return wordish >= Math.ceil(segs.length / 2);
}

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

/** Redact one string: known prefixes, credential assignments, then entropy sweeps. */
function redactString(s: string, path: string, hits: RedactionHit[], opts: RedactOptions): string {
  let out = s;
  for (const rule of PREFIX_RULES) {
    out = out.replace(rule.re, (m) => {
      record(hits, rule.type, path, m);
      return PLACEHOLDER(rule.type);
    });
  }
  // Credential-keyword assignments — catches low-entropy and slash-bearing values
  // that the entropy net alone would miss (e.g. DB_PASSWORD=hunter2, aws_secret_access_key=...).
  out = out.replace(ASSIGNMENT_RE, (m, val: string) => {
    record(hits, 'assigned-secret', path, val);
    return m.slice(0, m.length - val.length) + PLACEHOLDER('assigned-secret');
  });

  const minLen = opts.entropyMinLen ?? 24;
  const minBits = opts.entropyMinBits ?? 3.5;
  // Pass 1: path-safe charset (no / . -) so dash/slash/dot-delimited paths are
  // never mistaken for base64 blobs.
  out = out.replace(/[A-Za-z0-9+_=]{24,}/g, (tok) => {
    if (!isLikelySecret(tok, minLen, minBits)) return tok;
    record(hits, 'high-entropy', path, tok);
    return PLACEHOLDER('high-entropy');
  });
  // Pass 2: base64 secrets that contain '/' (e.g. ~half of AWS secret keys),
  // guarded so real filesystem paths are spared.
  out = out.replace(/[A-Za-z0-9+/=]{24,}/g, (tok) => {
    if (!tok.includes('/') || isPathLike(tok) || !isLikelySecret(tok, minLen, minBits)) return tok;
    record(hits, 'high-entropy', path, tok);
    return PLACEHOLDER('high-entropy');
  });
  return out;
}

/**
 * Redact a standalone text blob (a captured patch hunk or file body) with the
 * SAME rules the payload walk uses. This is the fail-closed gate every mutation
 * patch/body passes through before it is content-addressed and persisted — the
 * source strings are already redacted upstream (the tool_input walk), so this is
 * defense-in-depth that also catches any cross-line recombination in an assembled
 * hunk. Never throws: on an internal error the whole text is dropped to a hash.
 */
export function redactText(s: string, opts: RedactOptions = {}): { text: string; hits: RedactionHit[] } {
  const hits: RedactionHit[] = [];
  try {
    return { text: redactString(s, 'content', hits, opts), hits };
  } catch {
    return { text: PLACEHOLDER('redactor-error'), hits: [{ type: 'redactor-error', path: 'content', hash: hashString(s), bytes: Buffer.byteLength(s, 'utf8') }] };
  }
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
  const dropStr = (obj: Record<string, unknown>, key: string, path: string): void => {
    if (typeof obj[key] === 'string') {
      record(hits, 'path-sensitive-content', path, obj[key] as string);
      obj[key] = PLACEHOLDER('path-sensitive-content');
    }
  };

  if (input) {
    // Write/Edit/MultiEdit/NotebookEdit target a sensitive file → drop ALL written
    // text (content, old_string/new_string, edits[].*, new_source), regardless of entropy.
    const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? (input.notebook_path as string) : null;
    if (p && isSensitivePath(p)) {
      for (const k of ['content', 'old_string', 'new_string', 'new_source']) dropStr(input, k, `tool_input.${k}`);
      if (Array.isArray(input.edits)) {
        (input.edits as unknown[]).forEach((e, i) => {
          if (e && typeof e === 'object') {
            for (const k of ['old_string', 'new_string']) dropStr(e as Record<string, unknown>, k, `tool_input.edits[${i}].${k}`);
          }
        });
      }
    }
  }

  // Read result: tool_response.file.content with a sensitive filePath.
  const resp = payload.tool_response as Record<string, unknown> | undefined;
  const file = resp && typeof resp.file === 'object' ? (resp.file as Record<string, unknown>) : null;
  const respPath = file && typeof file.filePath === 'string' ? (file.filePath as string) : null;
  if (respPath && isSensitivePath(respPath)) dropStr(file!, 'content', 'tool_response.file.content');
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
