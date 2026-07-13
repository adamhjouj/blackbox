import { GENESIS, hashEvent } from './hash';
import { verifyCheckpoint, type Watermark } from './sign';
import type { Store } from './store';
import type { BlackboxEvent } from './types';

export type BreakReason =
  | 'content-tampered' // a column was edited after recording
  | 'broken-link' // prev_hash doesn't match the prior event (deletion / reorder / insertion)
  | 'bad-sequence' // seq isn't contiguous from 1
  | 'truncated' // fewer events than the head anchor records (tail deleted / full wipe)
  | 'signature-invalid'; // a signed checkpoint doesn't verify (chain re-signed with a wrong key / altered after signing)

export interface VerifyOptions {
  /** The trusted Ed25519 public key (PEM). When present, signed checkpoints are
   *  checked — catching a full rewrite the internal hash chain alone cannot. */
  trustedPublicKey?: string | null;
  /** The out-of-DB high-watermark (signing.head). When present, verify requires
   *  that checkpoint to still be present + valid in the DB — catching signature
   *  deletion / tail-rollback by a writer who can't reach the watermark file. */
  watermark?: Watermark | null;
}

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
export function verify(store: Store, opts: VerifyOptions = {}): VerifyResult {
  const meta = store.chainMeta();
  // Signed checkpoints (small table) are read up front so the streaming walk can
  // capture just the {hash, event_id} at the seqs they reference — no need to hold
  // the whole chain in memory to cross-check signatures afterwards.
  const sigs = opts.trustedPublicKey ? store.signatures() : [];
  const neededSeqs = new Set<number>();
  for (const s of sigs) neededSeqs.add(s.seq);
  if (opts.watermark) neededSeqs.add(opts.watermark.seq);
  const captured = new Map<number, { hash: string; event_id: string }>();

  const sessions = new Set<string>();
  let prevHash = GENESIS;
  let expectedSeq = 1;
  let walked = 0;
  let last: { seq: number; hash: string; event_id: string } | null = null;

  // Stream the chain from genesis (constant memory), recomputing every hash and
  // checking every link. Reports the FIRST break with the exact seq and kind.
  for (const row of store.iterateAll()) {
    sessions.add(row.session_id);
    walked += 1;

    if (row.seq !== expectedSeq) {
      return breakAt(row, 'bad-sequence', `expected seq ${expectedSeq}, found ${row.seq}`, walked, sessions.size, !!meta);
    }

    if (row.prev_hash !== prevHash) {
      return breakAt(
        row,
        'broken-link',
        `prev_hash does not match the prior event's hash — an event was deleted, reordered, or inserted before seq ${row.seq}`,
        walked,
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
        walked,
        sessions.size,
        !!meta,
      );
    }

    if (neededSeqs.has(row.seq)) captured.set(row.seq, { hash: row.hash, event_id: row.event_id });
    prevHash = row.hash;
    last = { seq: row.seq, hash: row.hash, event_id: row.event_id };
    expectedSeq += 1;
  }

  // The internal chain is consistent; now check it against the head anchor. A
  // valid PREFIX of a chain is itself internally valid, so without this a
  // deletion of the newest events (or a full wipe) would pass unnoticed.
  if (meta) {
    if (walked !== meta.count || !last || last.hash !== meta.head_hash) {
      return {
        ok: false,
        count: walked,
        sessions: sessions.size,
        anchored: true,
        break: {
          seq: meta.head_seq,
          event_id: last?.event_id ?? '(none)',
          reason: 'truncated',
          detail:
            `chain has ${walked} event(s) but the head anchor records ${meta.count} ` +
            `(head seq ${meta.head_seq}) — the most recent events were deleted, or the chain was wiped`,
        },
      };
    }
  }

  // Cryptographic checkpoints (R3). When the caller holds the trusted public key,
  // every signed head must (a) verify under that key and (b) still match the chain.
  // This catches a FULL rewrite — events + the same-file chain_meta re-hashed
  // consistently — that the internal walk cannot: an attacker can't forge a
  // signature without the private key. verify(store) with no key skips this.
  if (opts.trustedPublicKey) {
    for (const s of sigs) {
      if (!verifyCheckpoint(s.seq, s.head_hash, s.ts, s.sig, opts.trustedPublicKey)) {
        return sigBreak(s.seq, captured.get(s.seq)?.event_id, 'a signed checkpoint does not verify under the trusted key — the chain was re-signed with a different key', walked, sessions.size, !!meta);
      }
      const ev = captured.get(s.seq);
      if (!ev) {
        return sigBreak(s.seq, undefined, `a signed checkpoint at seq ${s.seq} has no event — the chain was truncated below a signed head`, walked, sessions.size, !!meta);
      }
      if (ev.hash !== s.head_hash) {
        return sigBreak(s.seq, ev.event_id, `the event at signed seq ${s.seq} no longer matches its signature — content was altered after signing`, walked, sessions.size, !!meta);
      }
    }
    // Anti-deletion: the newest checkpoint recorded OUT OF THE DB must still be
    // present + valid inside it. A DB-only attacker who deletes/rolls back the
    // signatures table can't reach this file, so the removal is caught. (A full
    // ~/.blackbox writer can rewrite the watermark too — the honest limit.)
    if (opts.watermark) {
      const w = opts.watermark;
      const match = sigs.find((s) => s.seq === w.seq && s.head_hash === w.head_hash);
      if (!match || !verifyCheckpoint(w.seq, w.head_hash, match.ts, match.sig, opts.trustedPublicKey)) {
        return sigBreak(w.seq, captured.get(w.seq)?.event_id, `the newest signed checkpoint (seq ${w.seq}) recorded outside the DB is missing or invalid — signatures were deleted or rolled back`, walked, sessions.size, !!meta);
      }
    }
  }

  return { ok: true, count: walked, sessions: sessions.size, anchored: !!meta };
}

function sigBreak(seq: number, eventId: string | undefined, detail: string, count: number, sessions: number, anchored: boolean): VerifyResult {
  return { ok: false, count, sessions, anchored, break: { seq, event_id: eventId ?? '(none)', reason: 'signature-invalid', detail } };
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
