import { execFileSync } from 'node:child_process';
import { hashString } from './hash';
import { redactText } from './redact';
import type { ActionType } from './types';

/**
 * Mutation capture: turn a file_write / file_edit into a small, redacted,
 * content-addressed piece of EVIDENCE plus an immutable FACT.
 *
 * The immutable/re-derivable boundary (do not collapse it):
 *   - The FACT ({kind, content_hash, bytes, diffstat, ...}) rides in the hashed
 *     `detail.mutation` — a cryptographic commitment to exactly what changed.
 *   - The CONTENT (the redacted patch/body bytes) lives in the un-hashed, content
 *     addressed `blobs` table, keyed by `content_hash`. It is self-verifying (its
 *     bytes must hash to its key) and prunable without touching any event hash.
 *
 * We store PATCHES for edits (old_string/new_string are already the small changed
 * snippet Claude Code passes) and FULL BODIES for writes, content-addressed so
 * identical bodies are stored exactly once.
 */

/** Skip storing content over ~1MB — keep the commitment (hash+size), drop bytes. */
const MAX_CONTENT_BYTES = 1024 * 1024;
/** Bound the O(m·n) line LCS so a pathological giant snippet can't stall the hook. */
const MAX_LCS_CELLS = 4_000_000;
/** A NUL byte marks content as binary — never store it as a text blob. */
const NUL = String.fromCharCode(0);

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/** The hashed commitment embedded in `detail.mutation`. */
export interface MutationFact {
  kind: 'patch' | 'body';
  /** sha256 of the REDACTED content — present even when content is skipped. */
  content_hash: string;
  /** Byte size of the redacted content. */
  bytes: number;
  diffstat: DiffStat;
  /** True when the blob content is persisted; false when skipped (see skip_reason). */
  stored: boolean;
  /** Why content bytes were not stored (the FACT is still recorded). */
  skip_reason?: 'oversize' | 'binary';
  /** True when the content carries a [REDACTED:…] marker (a secret was scrubbed). */
  redacted?: boolean;
}

/** A row for the content-addressed `blobs` table. */
export interface BlobInput {
  content_hash: string;
  content: string;
  bytes: number;
  encoding: 'utf8';
}

export interface MutationCapture {
  fact: MutationFact;
  /** null when content is skipped (oversize/binary) — the FACT still commits to it. */
  blob: BlobInput | null;
}

const REDACTED_MARKER = /\[REDACTED:/;

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * A compact line-level LCS diff → unified-diff-style hunk with accurate
 * insertion/deletion counts. Edit snippets are small, so O(m·n) is fine; a hard
 * cell cap falls back to replace-all so a huge snippet can never stall the hook.
 */
function lineDiff(oldText: string, newText: string): { hunk: string; insertions: number; deletions: number } {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const m = a.length;
  const n = b.length;
  const header = `@@ -1,${m} +1,${n} @@`;

  if (m * n > MAX_LCS_CELLS) {
    // Degenerate but valid: remove every old line, add every new line.
    const lines = [...a.map((l) => '-' + l), ...b.map((l) => '+' + l)];
    return { hunk: header + '\n' + lines.join('\n'), insertions: n, deletions: m };
  }

  // dp[i][j] = LCS length of a[i..], b[j..].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let insertions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(' ' + a[i]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push('-' + a[i]);
      i++;
      deletions++;
    } else {
      out.push('+' + b[j]);
      j++;
      insertions++;
    }
  }
  while (i < m) {
    out.push('-' + a[i]);
    i++;
    deletions++;
  }
  while (j < n) {
    out.push('+' + b[j]);
    j++;
    insertions++;
  }
  return { hunk: header + '\n' + out.join('\n'), insertions, deletions };
}

/** Build the raw (pre-final-redaction) content + diffstat for one mutation. */
function buildContent(
  action: ActionType,
  input: Record<string, unknown>,
): { kind: 'patch' | 'body'; content: string; diffstat: DiffStat } | null {
  if (action === 'file_write') {
    const body = asStr(input.content);
    if (body == null) return null;
    return {
      kind: 'body',
      content: body,
      diffstat: { files: 1, insertions: body.length ? body.split('\n').length : 0, deletions: 0 },
    };
  }

  // file_edit — Edit (old_string/new_string), MultiEdit (edits[]), NotebookEdit (new_source).
  const hunks: string[] = [];
  let insertions = 0;
  let deletions = 0;

  const addEdit = (oldS: string, newS: string): void => {
    const d = lineDiff(oldS, newS);
    hunks.push(d.hunk);
    insertions += d.insertions;
    deletions += d.deletions;
  };

  if (Array.isArray(input.edits)) {
    for (const e of input.edits as unknown[]) {
      if (e && typeof e === 'object') {
        const o = asStr((e as Record<string, unknown>).old_string) ?? '';
        const nw = asStr((e as Record<string, unknown>).new_string) ?? '';
        addEdit(o, nw);
      }
    }
  } else if (asStr(input.old_string) != null || asStr(input.new_string) != null) {
    addEdit(asStr(input.old_string) ?? '', asStr(input.new_string) ?? '');
  } else if (asStr(input.new_source) != null) {
    // NotebookEdit: a cell's new source, no prior text available → treat as insertion.
    addEdit('', asStr(input.new_source)!);
  } else {
    return null;
  }

  return { kind: 'patch', content: hunks.join('\n'), diffstat: { files: 1, insertions, deletions } };
}

/** Does the content look binary (a NUL byte)? Written text is normally a JS string,
 *  but guard so a binary blob is never stored as content. */
function looksBinary(s: string): boolean {
  return s.indexOf(NUL) !== -1;
}

/**
 * Capture a mutation from an ALREADY-REDACTED tool_input. Returns null for any
 * action that is not a file_write/file_edit, or one missing its content fields.
 * The assembled patch/body passes a final redactText() gate before it is hashed
 * and stored — fail-closed, defense-in-depth over the upstream tool_input walk.
 */
export function captureMutation(action: ActionType, input: Record<string, unknown>): MutationCapture | null {
  if (action !== 'file_write' && action !== 'file_edit') return null;
  const built = buildContent(action, input);
  if (!built) return null;

  // Final redaction gate — the source strings are already redacted upstream, so
  // this normally no-ops, but it guarantees nothing unredacted is ever persisted.
  const { text: content } = redactText(built.content);
  const bytes = Buffer.byteLength(content, 'utf8');
  const content_hash = hashString(content);
  const redacted = REDACTED_MARKER.test(content) || undefined;

  const base: MutationFact = { kind: built.kind, content_hash, bytes, diffstat: built.diffstat, stored: true, redacted };

  if (looksBinary(content)) {
    return { fact: { ...base, stored: false, skip_reason: 'binary' }, blob: null };
  }
  if (bytes > MAX_CONTENT_BYTES) {
    return { fact: { ...base, stored: false, skip_reason: 'oversize' }, blob: null };
  }
  return { fact: base, blob: { content_hash, content, bytes, encoding: 'utf8' } };
}

export interface SessionAnchor {
  head_sha: string | null;
  branch: string | null;
  reason?: string;
}

/**
 * The git HEAD the session started/ended at — recorded once per session so that
 * pre-session file state can later be REFERENCED from git objects (never copied
 * into our store). One or two fast, guarded git calls; failure is recorded, not
 * thrown. Called by the daemon on SessionStart/SessionEnd only (off the per-tool
 * path), so it never affects tool-call hook latency.
 */
export function sessionAnchor(cwd: string | null): SessionAnchor {
  if (!cwd) return { head_sha: null, branch: null, reason: 'no-cwd' };
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 250 }).trim();
    } catch {
      return null;
    }
  };
  const head_sha = run(['rev-parse', 'HEAD']);
  if (!head_sha) return { head_sha: null, branch: null, reason: 'not-a-repo' };
  return { head_sha, branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) };
}
