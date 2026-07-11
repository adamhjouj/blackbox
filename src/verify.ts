import { GENESIS, hashEvent } from './hash';
import type { Store } from './store';
import type { BlackboxEvent } from './types';

export type BreakReason =
  | 'content-tampered' // a column was edited after recording
  | 'broken-link' // prev_hash doesn't match the prior event (deletion / reorder / insertion)
  | 'bad-sequence' // seq isn't contiguous from 1
  | 'truncated'; // fewer events than the head anchor records (tail deleted / full wipe)

export interface VerifyResult {
  ok: boolean;
  count: number;
  sessions: number;
  /** True when a head anchor existed and was checked against the chain. */
  anchored: boolean;
  break?: {
    seq: number;
    event_id: string;
    reason: BreakReason;
    detail: string;
  };
}

/**
 * Walk the chain from genesis, recomputing every hash and checking every link,
 * then check the head anchor to catch tail-truncation (which a bare prefix walk
 * cannot). Reports the FIRST break with the exact seq and what kind it is.
 */
export function verify(store: Store): VerifyResult {
  const rows = store.all();
  const meta = store.chainMeta();
  const sessions = new Set<string>();
  let prevHash = GENESIS;
  let expectedSeq = 1;

  for (const row of rows) {
    sessions.add(row.session_id);

    if (row.seq !== expectedSeq) {
      return breakAt(row, 'bad-sequence', `expected seq ${expectedSeq}, found ${row.seq}`, rows.length, sessions.size, !!meta);
    }

    if (row.prev_hash !== prevHash) {
      return breakAt(
        row,
        'broken-link',
        `prev_hash does not match the prior event's hash — an event was deleted, reordered, or inserted before seq ${row.seq}`,
        rows.length,
        sessions.size,
        !!meta,
      );
    }

    const { hash, ...withoutHash } = row;
    const recomputed = hashEvent(withoutHash as Record<string, unknown>);
    if (recomputed !== hash) {
      return breakAt(
        row,
        'content-tampered',
        `stored hash does not match recomputed hash — a field on this event was modified after it was recorded`,
        rows.length,
        sessions.size,
        !!meta,
      );
    }

    prevHash = row.hash;
    expectedSeq += 1;
  }

  // The internal chain is consistent; now check it against the head anchor. A
  // valid PREFIX of a chain is itself internally valid, so without this a
  // deletion of the newest events (or a full wipe) would pass unnoticed.
  if (meta) {
    const last = rows[rows.length - 1];
    if (rows.length !== meta.count || !last || last.hash !== meta.head_hash) {
      return {
        ok: false,
        count: rows.length,
        sessions: sessions.size,
        anchored: true,
        break: {
          seq: meta.head_seq,
          event_id: last?.event_id ?? '(none)',
          reason: 'truncated',
          detail:
            `chain has ${rows.length} event(s) but the head anchor records ${meta.count} ` +
            `(head seq ${meta.head_seq}) — the most recent events were deleted, or the chain was wiped`,
        },
      };
    }
  }

  return { ok: true, count: rows.length, sessions: sessions.size, anchored: !!meta };
}

function breakAt(
  row: BlackboxEvent,
  reason: BreakReason,
  detail: string,
  count: number,
  sessions: number,
  anchored: boolean,
): VerifyResult {
  return {
    ok: false,
    count,
    sessions,
    anchored,
    break: { seq: row.seq, event_id: row.event_id, reason, detail },
  };
}
