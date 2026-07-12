/**
 * Provenance — the re-traceable "session story".
 *
 * A PURE, read-time projection that turns the flat event stream into a causal
 * narrative: user prompt → the steps the agent took → what changed (files, commits).
 * It is an INTERPRETATION, exactly like `explain.ts` and the risk engine — derived
 * from the immutable chain, never written back, never hashed. `verify()` is
 * untouched by anything here. Because it's pure (actions + a per-seq detail map in,
 * a SessionStory out), it unit-tests without a store.
 *
 * Turn grouping is by `prompt_id` (the join key Claude Code stamps on a
 * UserPromptSubmit and every tool event of that turn). Sessions recorded before
 * prompt capture existed still group into turns by `prompt_id` — they just carry a
 * null `prompt` (intent unknown), which is honest degradation, not a failure.
 */
import type { Action } from './read-api';
import type { FlagId } from './risk-rules';
import { RISK_FLAGS } from './risk-rules';

/** Model/usage metadata for a turn (R1), from the transcript. */
export interface TurnMeta {
  model?: string | null;
  usage?: Record<string, number> | null;
  stop_reason?: string | null;
  assistant_messages?: number;
}

/** The subset of a parsed `detail` bag the story needs, keyed by event seq. */
export interface EventDetail {
  prompt?: string;
  parent_tool_use_id?: string;
  reasoning?: string; // R1: the turn's redacted reasoning digest (on a reasoning event)
  turn_meta?: TurnMeta;
  mutation?: { kind?: string; diffstat?: { files?: number; insertions?: number; deletions?: number }; stored?: boolean; skip_reason?: string };
  git?: {
    ref?: string;
    kind?: string;
    diffstat?: { files?: number; insertions?: number; deletions?: number } | null;
    commit?: { sha?: string; subject?: string; author?: string; ts?: string } | null;
  };
}

/** One file touched, with the seq to drill into for the full diff. */
export interface FileChange {
  path: string;
  kind: string; // 'patch' | 'body'
  insertions: number;
  deletions: number;
  status: 'stored' | 'skipped';
  skip_reason: string | null;
  seq: number; // the POST event seq — click-through to the diff dossier
}

/** A git commit (or ref change) recorded during the turn. */
export interface Commit {
  seq: number;
  sha: string | null;
  subject: string | null;
  ref: string | null;
  kind: string | null;
  insertions: number;
  deletions: number;
  files: number;
}

/** One action the agent took, within a turn. */
export interface StoryStep {
  seq: number;
  post_seq: number | null;
  ts: string;
  type: string;
  tool: string | null;
  target: string | null;
  summary: string;
  success: 0 | 1 | null;
  duration_ms: number | null;
  signals: FlagId[];
  score: number;
  agent_type: string | null;
  is_subagent: boolean;
  files: FileChange[]; // usually 0 or 1 (the file this step wrote/edited)
}

/** One user turn: the intent, the steps, and the outcomes. */
export interface Turn {
  prompt_id: string | null;
  prompt: string | null; // null for pre-capture sessions or lifecycle preamble
  reasoning: string | null; // R1: the agent's redacted reasoning digest (the "why")
  turn_meta: TurnMeta | null; // R1: model + token usage for the turn
  started_at: string;
  ended_at: string;
  steps: StoryStep[];
  files_changed: FileChange[]; // deduped rollup across the turn's steps
  commits: Commit[];
  flags: Record<string, number>; // risk-flag counts in this turn
  flagged: number; // # steps carrying a risk flag
  max_score: number;
}

export interface SessionStory {
  session_id: string;
  name: string | null;
  cwd: string | null;
  verdict: string;
  turns: Turn[];
  files_changed: FileChange[]; // session-level rollup
  commits: Commit[];
  counts: { turns: number; steps: number; files: number; commits: number };
}

export interface StoryInput {
  session_id: string;
  name: string | null;
  cwd: string | null;
  verdict: string;
  actions: Action[]; // Pre/Post-paired timeline (from sessionActions)
  detailBySeq: Map<number, EventDetail>; // parsed detail per event seq (from eventsLight)
}

const isMain = (agentType: string | null): boolean => !agentType || agentType === 'main';

/** A GitRefTransaction event carrying a real commit — surfaced as an outcome, not a step. */
function commitFrom(action: Action, d: EventDetail | undefined): Commit | null {
  const g = d?.git;
  if (action.hook_event !== 'GitRefTransaction' || !g) return null;
  const ds = g.diffstat ?? undefined;
  return {
    seq: action.seq,
    sha: g.commit?.sha ?? null,
    subject: g.commit?.subject ?? null,
    ref: g.ref ?? null,
    kind: g.kind ?? null,
    insertions: ds?.insertions ?? 0,
    deletions: ds?.deletions ?? 0,
    files: ds?.files ?? 0,
  };
}

/** The file this step wrote/edited, from the POST event's mutation fact. */
function fileFrom(action: Action, d: EventDetail | undefined): FileChange | null {
  const m = d?.mutation;
  if (!m || !action.target) return null;
  const ds = m.diffstat ?? {};
  return {
    path: action.target,
    kind: m.kind ?? 'patch',
    insertions: ds.insertions ?? 0,
    deletions: ds.deletions ?? 0,
    status: m.stored === false ? 'skipped' : 'stored',
    skip_reason: m.skip_reason ?? null,
    seq: action.post_seq ?? action.seq,
  };
}

/** Merge file changes to the same path (sum churn, keep the latest seq to drill into). */
function rollup(files: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const f of files) {
    const prev = byPath.get(f.path);
    if (!prev) {
      byPath.set(f.path, { ...f });
    } else {
      prev.insertions += f.insertions;
      prev.deletions += f.deletions;
      prev.seq = f.seq; // latest change wins for click-through
      if (f.status === 'skipped') prev.status = 'skipped';
    }
  }
  return [...byPath.values()];
}

function newTurn(prompt_id: string | null, prompt: string | null, at: string): Turn {
  return { prompt_id, prompt, reasoning: null, turn_meta: null, started_at: at, ended_at: at, steps: [], files_changed: [], commits: [], flags: {}, flagged: 0, max_score: 0 };
}

/**
 * Project a session's paired actions + per-seq detail into a SessionStory.
 * Pure: same input always yields the same output; no store, no clock, no I/O.
 */
export function buildStory(input: StoryInput): SessionStory {
  const { actions, detailBySeq } = input;
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const a of actions) {
    // Prompt/git/lifecycle facts ride on the event's own seq; a mutation fact is
    // recorded on the POST event, so files come from the post_seq's detail.
    const d = detailBySeq.get(a.seq);
    const dPost = a.post_seq != null ? detailBySeq.get(a.post_seq) : undefined;

    // A UserPromptSubmit opens a new turn and carries its intent.
    if (a.phase === 'prompt') {
      current = newTurn(a.prompt_id, d?.prompt ?? null, a.ts);
      turns.push(current);
      continue;
    }

    // R1: a reasoning event attaches to its turn (by prompt_id) — never a step, never
    // a new turn. It's appended async after Stop, so it can arrive out of seq order.
    if (a.phase === 'reasoning') {
      const t = turns.find((x) => x.prompt_id === a.prompt_id) ?? current;
      if (t) {
        if (d?.reasoning) t.reasoning = d.reasoning;
        if (d?.turn_meta) t.turn_meta = d.turn_meta;
      }
      continue;
    }

    // A real tool step whose prompt_id starts a new turn we haven't opened yet
    // (pre-capture sessions have no prompt events; git/lifecycle rows have a null
    // prompt_id and stay in the active turn).
    if (a.prompt_id && (!current || current.prompt_id !== a.prompt_id)) {
      current = newTurn(a.prompt_id, null, a.ts);
      turns.push(current);
    }
    // Events before any prompt/turn (session-start preamble) get a headless turn.
    if (!current) {
      current = newTurn(null, null, a.ts);
      turns.push(current);
    }

    current.ended_at = a.ts;

    // A commit is an outcome of the turn, not a step in it.
    const commit = commitFrom(a, d);
    if (commit) {
      current.commits.push(commit);
      continue;
    }

    const file = fileFrom(a, dPost);
    const step: StoryStep = {
      seq: a.seq,
      post_seq: a.post_seq,
      ts: a.ts,
      type: a.type,
      tool: a.tool,
      target: a.target,
      summary: a.summary,
      success: a.success,
      duration_ms: a.duration_ms,
      signals: a.signals,
      score: a.score,
      agent_type: a.agent_type,
      is_subagent: !isMain(a.agent_type),
      files: file ? [file] : [],
    };
    current.steps.push(step);

    for (const s of a.signals) if (RISK_FLAGS.has(s)) current.flags[s] = (current.flags[s] ?? 0) + 1;
    if (a.signals.some((s) => RISK_FLAGS.has(s))) current.flagged += 1;
    if (a.score > current.max_score) current.max_score = a.score;
  }

  // Roll up files per turn and for the whole session.
  const allFiles: FileChange[] = [];
  const allCommits: Commit[] = [];
  let stepCount = 0;
  for (const t of turns) {
    const files = t.steps.flatMap((s) => s.files);
    t.files_changed = rollup(files);
    allFiles.push(...files);
    allCommits.push(...t.commits);
    stepCount += t.steps.length;
  }
  const sessionFiles = rollup(allFiles);

  return {
    session_id: input.session_id,
    name: input.name,
    cwd: input.cwd,
    verdict: input.verdict,
    turns,
    files_changed: sessionFiles,
    commits: allCommits,
    counts: { turns: turns.length, steps: stepCount, files: sessionFiles.length, commits: allCommits.length },
  };
}
