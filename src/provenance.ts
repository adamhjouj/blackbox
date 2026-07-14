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
import type { Coverage, Discrepancy } from './reconcile';
import type { FlagId } from './risk-rules';
import { RISK_FLAGS } from './risk-rules';
import type { TranscriptTurnFacts } from './transcript';

/** R2 reconciliation summary attached to the story (populated by read-api). */
export interface ReconSummary {
  corroborated: boolean;
  finding_count: number;
  findings: Discrepancy[];
  coverage: Coverage;
}

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
  /** Concise, nonempty navigation label. It is either an exact prompt projection
   * or an explicitly-labelled fact-based fallback; never an invented prompt. */
  display_title: string;
  title_source: 'captured_prompt' | 'recovered_prompt' | 'assistant_explanation' | 'subagent_action' | 'recorded_action' | 'commit';
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
  reconciliation: ReconSummary | null; // R2 — populated by read-api.sessionStory
  blast_radius?: BlastRadius | null; // read-only rollup — populated by read-api.sessionStory
}

/** The session's reach: the KINDS of secret the redactor caught (aws-access-key,
 *  github-token, …) and the external hosts reached. A pure read projection assembled
 *  by read-api from the redaction facts + risk evidence that already ride each event
 *  (no capture-side field). Kinds, not paths: a redaction's `path` is a payload
 *  field-location, not a file — the class of secret is the meaningful blast-radius
 *  signal and stays clean even on sessions that analyze hostile code. */
export interface BlastRadius {
  secret_kinds: string[];
  egress_hosts: string[];
}

export interface StoryInput {
  session_id: string;
  name: string | null;
  cwd: string | null;
  verdict: string;
  actions: Action[]; // Pre/Post-paired timeline (from sessionActions)
  detailBySeq: Map<number, EventDetail>; // parsed detail per event seq (from eventsLight)
  /** Optional redacted/bounded local transcript recovery. Read-time only: these
   * facts never alter the immutable event chain. Persisted detail wins. */
  recoveredTurns?: ReadonlyMap<string, TranscriptTurnFacts>;
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
  return {
    prompt_id,
    prompt,
    reasoning: null,
    turn_meta: null,
    display_title: '',
    title_source: 'recorded_action',
    started_at: at,
    ended_at: at,
    steps: [],
    files_changed: [],
    commits: [],
    flags: {},
    flagged: 0,
    max_score: 0,
  };
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();
const titleText = (value: string, max = 180): string => {
  const points = Array.from(oneLine(value));
  return points.length > max ? points.slice(0, max).join('') + '…' : points.join('');
};

// The harness feeds wrapper blocks (task notifications, system reminders, slash-command
// I/O) back as "user prompts", so they get captured/recovered exactly like real prompts.
// Titling a turn with that raw XML is unreadable, so we detect it and let the ladder fall
// through to what the turn actually did, labelling the block itself only as a last resort.
const INJECTED_BLOCK = /^<(task-notification|system-reminder|command-(?:name|message|args|stdout)|local-command-[a-z-]+)\b/;
function injectedLabel(prompt: string): string {
  const tag = /^<([a-z-]+)/.exec(oneLine(prompt));
  if (tag && tag[1] === 'task-notification') return 'Background task update';
  if (tag && tag[1] === 'system-reminder') return 'System reminder';
  return 'Local command';
}

function titleTurn(turn: Turn, recoveredPrompt: boolean): void {
  if (turn.prompt && !INJECTED_BLOCK.test(oneLine(turn.prompt))) {
    turn.display_title = titleText(turn.prompt);
    turn.title_source = recoveredPrompt ? 'recovered_prompt' : 'captured_prompt';
    return;
  }
  if (turn.reasoning) {
    turn.display_title = titleText('Agent response · ' + turn.reasoning);
    turn.title_source = 'assistant_explanation';
    return;
  }
  const first = turn.steps[0];
  if (first) {
    const fact = first.summary || first.target || first.tool || first.type || 'Recorded action';
    const subagentOnly = turn.steps.every((step) => step.is_subagent);
    turn.display_title = titleText((subagentOnly ? 'Subagent work · ' : 'Prompt unavailable · ') + fact);
    turn.title_source = subagentOnly ? 'subagent_action' : 'recorded_action';
    return;
  }
  const commit = turn.commits[0];
  if (commit) {
    turn.display_title = titleText('Commit · ' + (commit.subject || commit.sha || commit.ref || 'recorded change'));
    turn.title_source = 'commit';
    return;
  }
  if (turn.prompt) {
    turn.display_title = injectedLabel(turn.prompt);
    turn.title_source = 'recorded_action';
  }
}

/**
 * Project a session's paired actions + per-seq detail into a SessionStory.
 * Pure: same input always yields the same output; no store, no clock, no I/O.
 */
export function buildStory(input: StoryInput): SessionStory {
  const { actions, detailBySeq } = input;
  const recoveredTurns = input.recoveredTurns ?? new Map<string, TranscriptTurnFacts>();
  const turns: Turn[] = [];
  const byPrompt = new Map<string, Turn>();
  let current: Turn | null = null;

  const ensureTurn = (promptId: string | null, prompt: string | null, at: string): Turn => {
    const existing = promptId ? byPrompt.get(promptId) : null;
    if (existing) {
      if (!existing.prompt && prompt) existing.prompt = prompt;
      current = existing;
      return existing;
    }
    const created = newTurn(promptId, prompt, at);
    turns.push(created);
    if (promptId) byPrompt.set(promptId, created);
    current = created;
    return created;
  };

  for (const a of actions) {
    // Prompt/git/lifecycle facts ride on the event's own seq; a mutation fact is
    // recorded on the POST event, so files come from the post_seq's detail.
    const d = detailBySeq.get(a.seq);
    const dPost = a.post_seq != null ? detailBySeq.get(a.post_seq) : undefined;

    // A UserPromptSubmit opens a new turn and carries its intent.
    if (a.phase === 'prompt') {
      ensureTurn(a.prompt_id, d?.prompt ?? null, a.ts);
      continue;
    }

    // R1: a reasoning event attaches to its turn (by prompt_id) — never a step, never
    // a new turn. It's appended async after Stop, so it can arrive out of seq order.
    if (a.phase === 'reasoning') {
      const t = a.prompt_id ? byPrompt.get(a.prompt_id) ?? ensureTurn(a.prompt_id, null, a.ts) : current;
      if (t) {
        if (d?.reasoning) t.reasoning = d.reasoning;
        if (d?.turn_meta) t.turn_meta = d.turn_meta;
      }
      continue;
    }

    // Lifecycle rows set turn boundaries but are not actions the agent took. Keep
    // an answer-only historical turn only when the transcript has real content for
    // its prompt_id; otherwise do not promote system containers into Activity.
    if (a.type === 'session') {
      const recovered = a.prompt_id ? recoveredTurns.get(a.prompt_id) : null;
      const existing = a.prompt_id ? byPrompt.get(a.prompt_id) : null;
      if (existing) current = existing;
      else if (a.prompt_id && (recovered?.prompt || recovered?.reasoning)) ensureTurn(a.prompt_id, null, a.ts);
      if (current && (!a.prompt_id || current.prompt_id === a.prompt_id)) current.ended_at = a.ts;
      continue;
    }

    // A real tool step whose prompt_id starts a new turn we haven't opened yet
    // (pre-capture sessions have no prompt events; git/lifecycle rows have a null
    // prompt_id and stay in the active turn).
    let active = current;
    if (a.prompt_id && (!active || active.prompt_id !== a.prompt_id)) active = ensureTurn(a.prompt_id, null, a.ts);
    // Events before any prompt/turn (session-start preamble) get a headless turn.
    if (!active) active = ensureTurn(null, null, a.ts);
    current = active;

    active.ended_at = a.ts;

    // A commit is an outcome of the turn, not a step in it.
    const commit = commitFrom(a, d);
    if (commit) {
      active.commits.push(commit);
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
    active.steps.push(step);

    for (const s of a.signals) if (RISK_FLAGS.has(s)) active.flags[s] = (active.flags[s] ?? 0) + 1;
    if (a.signals.some((s) => RISK_FLAGS.has(s))) active.flagged += 1;
    if (a.score > active.max_score) active.max_score = a.score;
  }

  // Persisted prompt/reasoning facts are authoritative. Fill only their gaps from
  // the safely redacted, bounded transcript projection and mark the label source.
  const recoveredPromptIds = new Set<string>();
  for (const turn of turns) {
    if (!turn.prompt_id) continue;
    const recovered = recoveredTurns.get(turn.prompt_id);
    if (!recovered) continue;
    if (!turn.prompt && recovered.prompt) {
      turn.prompt = recovered.prompt;
      recoveredPromptIds.add(turn.prompt_id);
    }
    if (!turn.reasoning && recovered.reasoning) turn.reasoning = recovered.reasoning;
    if (!turn.turn_meta && (recovered.model || recovered.usage || recovered.stop_reason || recovered.assistant_messages)) {
      turn.turn_meta = {
        model: recovered.model,
        usage: recovered.usage,
        stop_reason: recovered.stop_reason,
        assistant_messages: recovered.assistant_messages,
      };
    } else if (turn.turn_meta) {
      turn.turn_meta = {
        model: turn.turn_meta.model ?? recovered.model,
        usage: turn.turn_meta.usage ?? recovered.usage,
        stop_reason: turn.turn_meta.stop_reason ?? recovered.stop_reason,
        assistant_messages: turn.turn_meta.assistant_messages ?? recovered.assistant_messages,
      };
    }
  }

  // Pure lifecycle containers disappear; prompt-only and answer-only turns remain.
  const retained = turns.filter((turn) => !!turn.prompt || !!turn.reasoning || turn.steps.length > 0 || turn.commits.length > 0);
  for (const turn of retained) titleTurn(turn, !!turn.prompt_id && recoveredPromptIds.has(turn.prompt_id));

  // Roll up files per turn and for the whole session.
  const allFiles: FileChange[] = [];
  const allCommits: Commit[] = [];
  let stepCount = 0;
  for (const t of retained) {
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
    turns: retained,
    files_changed: sessionFiles,
    commits: allCommits,
    counts: { turns: retained.length, steps: stepCount, files: sessionFiles.length, commits: allCommits.length },
    reconciliation: null, // read-api attaches the persisted R2 summary
  };
}
