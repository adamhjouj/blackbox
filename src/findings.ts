import type { ComboFire } from './risk-engine';
import type { BlackboxEvent } from './types';

/**
 * The observed completion state of a causal finding's consequent action.
 *
 * This is deliberately a read-time projection. Existing ruleset results and
 * immutable event bytes stay untouched; old recordings gain truthful outcome
 * language as soon as they are opened with a newer Blackbox.
 */
export type FindingOutcome = 'attempted' | 'succeeded' | 'failed' | 'unknown';

export interface FindingView extends ComboFire {
  outcome: FindingOutcome;
  /** Outcome-aware copy. `note` remains the persisted ruleset text. */
  display_note: string;
  /** Every event that supports the finding, including the paired completion. */
  related_seqs: number[];
}

export function eventOutcome(event: BlackboxEvent): FindingOutcome {
  if (event.phase === 'failure') return 'failed';
  if (event.phase === 'post') return event.success === 0 ? 'failed' : 'succeeded';
  if (event.phase === 'pre') return 'attempted';
  if (event.success === 0) return 'failed';
  if (event.success === 1) return 'succeeded';
  return 'unknown';
}

/** Project an action outcome from the complete tool-use group. Delivery order is
 * not assumed: hooks are asynchronous and a terminal can be captured first. */
export function actionOutcome(events: BlackboxEvent[], event: BlackboxEvent): FindingOutcome {
  if (!event.tool_use_id) return eventOutcome(event);
  const group = events.filter((candidate) => candidate.tool_use_id === event.tool_use_id);
  const states = new Set<FindingOutcome>();
  for (const candidate of group) {
    const state = eventOutcome(candidate);
    if (state === 'succeeded' || state === 'failed') states.add(state);
  }
  if (states.size > 1) return 'unknown';
  if (states.has('failed')) return 'failed';
  if (states.has('succeeded')) return 'succeeded';
  if (group.some((candidate) => candidate.phase === 'pre')) return 'attempted';
  return 'unknown';
}

function observedOutcome(events: BlackboxEvent[], combo: ComboFire): { outcome: FindingOutcome; terminals: BlackboxEvent[] } {
  const consequent = events.find((event) => event.seq === combo.consequent_seq);
  if (!consequent) return { outcome: 'unknown', terminals: [] };
  const group = consequent.tool_use_id
    ? events.filter((event) => event.tool_use_id === consequent.tool_use_id)
    : [consequent];
  const terminals = group.filter((event) => event.phase === 'post' || event.phase === 'failure' || (event.phase !== 'pre' && event.success !== null));
  return { outcome: actionOutcome(events, consequent), terminals };
}

function asAttempt(note: string): string {
  return note
    .replace(/\bsent to\b/i, 'was submitted for transfer to')
    .replace(/\bshipped sensitive file\b/i, 'attempted to send sensitive file')
    .replace(/\bexternal send\b/i, 'external-send attempt');
}

function hostFromTarget(target: string | null): string | undefined {
  if (!target) return undefined;
  const match = target.match(/https?:\/\/([a-z0-9.-]+)(?::\d+)?/i);
  return match?.[1];
}

/** Replace outcome claims in an old ruleset note without changing that ruleset. */
export function outcomeAwareNote(note: string, outcome: FindingOutcome): string {
  if (outcome === 'succeeded') return `${note}. The tool reported success; Blackbox has no packet-level delivery confirmation.`;
  if (outcome === 'failed') return `${asAttempt(note)}. The recorded tool result was failure; Blackbox observed no successful completion.`;
  if (outcome === 'attempted') return `${asAttempt(note)}. Blackbox observed the attempt but no completion event.`;
  return `${asAttempt(note)}. Blackbox could not determine the action outcome from the recorded events.`;
}

/** Add completion truth to persisted combo findings, deterministically. */
export function projectFindings(events: BlackboxEvent[], combos: ComboFire[]): FindingView[] {
  return combos.map((combo) => {
    const { outcome, terminals } = observedOutcome(events, combo);
    const related = new Set<number>([combo.antecedent_seq, combo.consequent_seq]);
    for (const terminal of terminals) related.add(terminal.seq);
    return {
      ...combo,
      host: combo.host ?? hostFromTarget(events.find((event) => event.seq === combo.consequent_seq)?.target ?? null),
      outcome,
      display_note: outcomeAwareNote(combo.note, outcome),
      related_seqs: [...related].sort((a, b) => a - b),
    };
  });
}
