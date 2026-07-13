/**
 * R1 — deep intent. Reads the Claude Code transcript `.jsonl` (path already stored
 * on hook payloads) to recover the turn's "why": the agent's own words + the
 * model/token cost. Only the FACTS (a bounded, redacted digest + model/usage) are
 * captured into the hashed chain; the full verbatim transcript is never copied.
 *
 * IMPORTANT (verified against Claude Code 2.1.x): `thinking` blocks are stored with
 * an EMPTY `thinking` field — the real reasoning is encrypted in the opaque
 * `signature`, not plaintext. So the digest is primarily the assistant's `text`
 * blocks (its stated response/summary for the turn), plus any non-empty thinking.
 * That is honest: we capture the agent's *stated* intent, not its private thoughts.
 *
 * Read defensively — the transcript is Claude Code's internal format, not a stable
 * API. Tail-read only (bounded), so this never loads a multi-MB file, and it runs
 * off the hook path (the daemon schedules it after replying). Any parse hiccup
 * degrades to null, never throws.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Read at most the last ~512 KB — the just-finished turn's records are at the end. */
const TAIL_BYTES = 512 * 1024;

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

export interface TurnIntent {
  /** The turn this reasoning belongs to (transcript `promptId` == hook `prompt_id`). */
  promptId: string;
  /** The agent's words for the turn: its `text` output plus any non-empty `thinking`,
   *  concatenated (raw; the caller redacts + bounds). Opaque thinking `signature`s are
   *  dropped. Usually the assistant's stated response, since thinking is encrypted. */
  reasoning: string;
  model: string | null;
  usage: Record<string, number> | null;
  stop_reason: string | null;
  assistant_messages: number;
}

function mergeUsage(acc: Record<string, number> | null, u: Record<string, unknown>): Record<string, number> {
  const out = acc ?? {};
  for (const k of USAGE_KEYS) if (typeof u[k] === 'number') out[k] = (out[k] ?? 0) + (u[k] as number);
  return out;
}

/**
 * Extract a turn's intent from the transcript. When `promptId` is given, filters to
 * it; otherwise uses the LAST assistant record's promptId (the just-finished turn —
 * the Stop payload may not carry a prompt_id). Returns null if nothing usable.
 */
/** Read at most the last `tailBytes` of a file as UTF-8, dropping the partial
 *  first line when the cut lands mid-line. Both transcript readers use this so
 *  neither loads a multi-MB `.jsonl` in full on the read/HTTP path. */
export function readTail(path: string, tailBytes: number = TAIL_BYTES): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n'); // drop a partial first line from the tail cut
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

const CUSTOM_TITLE = /"customTitle":"((?:[^"\\]|\\.)*)"/g;
const AI_TITLE = /"aiTitle":"((?:[^"\\]|\\.)*)"/g;

function lastTitleMatch(text: string, re: RegExp): string | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1] ?? null;
  return last;
}

/**
 * The human-readable session title from a transcript: the user's /rename
 * (customTitle) if set, else the AI-generated aiTitle. Bounded tail read — the
 * title record is re-emitted continuously, so the newest sits near EOF (verified
 * within 512 KB across every local transcript, incl. a 36 MB one). Last-match-wins.
 */
export function sessionTitleFromTranscript(path: string): string | null {
  const text = readTail(path);
  if (text == null) return null;
  const raw = lastTitleMatch(text, CUSTOM_TITLE) ?? lastTitleMatch(text, AI_TITLE);
  if (raw == null) return null;
  try {
    return JSON.parse('"' + raw + '"') as string; // unescape any JSON escapes
  } catch {
    return raw;
  }
}

export function readTurnIntent(path: string, promptId?: string | null): TurnIntent | null {
  const text = readTail(path);
  if (text == null) return null;
  try {
    // Only `user` records carry `promptId`; `assistant` records don't. So assign
    // each assistant to the most recent user promptId before it (the turn it belongs
    // to). Tool-result "user" records within a turn carry no new promptId, so the
    // current turn persists across them.
    const asst: { promptId: string | null; message: Record<string, unknown> }[] = [];
    let cur: string | null = null;
    let lastUserPid: string | null = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (o.type === 'user' && typeof o.promptId === 'string') {
        cur = o.promptId;
        lastUserPid = o.promptId;
      } else if (o.type === 'assistant' && o.message && typeof o.message === 'object') {
        asst.push({ promptId: cur, message: o.message as Record<string, unknown> });
      }
    }
    if (!asst.length) return null;

    // Target the requested turn; if none requested, the last turn in the tail (the
    // just-finished one at Stop). Strict match — never guess a different turn, or we'd
    // mis-attribute reasoning. The Stop turn's user record is always within the tail.
    const target = promptId ?? asst[asst.length - 1]!.promptId ?? lastUserPid;
    const matching = target != null ? asst.filter((a) => a.promptId === target) : [];
    if (!matching.length) return null;
    const resolvedPromptId = target!; // matched, so non-null

    const parts: string[] = [];
    let model: string | null = null;
    let usage: Record<string, number> | null = null;
    let stop_reason: string | null = null;
    for (const { message: m } of matching) {
      if (typeof m.model === 'string') model = m.model;
      if (typeof m.stop_reason === 'string') stop_reason = m.stop_reason;
      if (m.usage && typeof m.usage === 'object') usage = mergeUsage(usage, m.usage as Record<string, unknown>);
      if (Array.isArray(m.content)) {
        for (const b of m.content as unknown[]) {
          const blk = b as Record<string, unknown>;
          if (!blk) continue;
          // non-empty thinking (rare — usually encrypted-empty) OR the assistant's text
          if (blk.type === 'thinking' && typeof blk.thinking === 'string' && blk.thinking.trim()) parts.push(blk.thinking.trim());
          else if (blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) parts.push(blk.text.trim());
        }
      }
    }
    return { promptId: resolvedPromptId, reasoning: parts.join('\n\n'), model, usage, stop_reason, assistant_messages: matching.length };
  } catch {
    return null;
  }
}
