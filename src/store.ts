import Database from 'better-sqlite3';
import { GENESIS, hashEvent } from './hash';
import type { BlackboxEvent, NormalizedEvent } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  session_id      TEXT NOT NULL,
  tool_use_id     TEXT,
  prompt_id       TEXT,
  phase           TEXT NOT NULL,
  hook_event      TEXT NOT NULL,
  tool_name       TEXT,
  action_type     TEXT NOT NULL,
  target          TEXT,
  agent_id        TEXT,
  agent_type      TEXT,
  cwd             TEXT,
  permission_mode TEXT,
  success         INTEGER,
  duration_ms     INTEGER,
  ts              TEXT NOT NULL,
  captured_at     TEXT NOT NULL,
  raw             TEXT NOT NULL,
  prev_hash       TEXT NOT NULL,
  hash            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_tooluse ON events(tool_use_id);

-- Head anchor: lets verify detect tail-truncation / full-wipe, which a bare
-- prefix walk cannot (any valid prefix is itself a valid chain). Updated in the
-- SAME transaction as each append, so it is always consistent with the events.
-- Honest limit: it lives in the same file, so an attacker who also rewrites this
-- row defeats it — true resistance needs an EXTERNAL anchor (remote/signed) [LATER].
CREATE TABLE IF NOT EXISTS chain_meta (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  count     INTEGER NOT NULL,
  head_seq  INTEGER NOT NULL,
  head_hash TEXT NOT NULL
);
`;

export interface ChainMeta {
  count: number;
  head_seq: number;
  head_hash: string;
}

export interface SessionSummary {
  session_id: string;
  events: number;
  started: string;
  ended: string;
  failures: number;
}

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD so a JS string hashes to the
 * SAME bytes it will be stored as. SQLite stores TEXT as UTF-8 and V8 maps lone
 * surrogates to U+FFFD on encode; without this, append (in-memory value) and
 * verify (read-back value) would disagree and falsely report tampering.
 */
function wellFormed(s: string): string {
  const anyStr = s as unknown as { toWellFormed?: () => string };
  if (typeof anyStr.toWellFormed === 'function') return anyStr.toWellFormed();
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  );
}

/** Sanitize every string field so stored bytes == hashed bytes for all columns. */
function sanitize(e: NormalizedEvent): NormalizedEvent {
  const out = { ...e } as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string') out[k] = wellFormed(out[k] as string);
  }
  return out as NormalizedEvent;
}

/**
 * Append-only, hash-chained event store backed by SQLite (WAL). The blackbox
 * daemon is the single writer, so writes serialize naturally; WAL lets the
 * timeline UI read concurrently.
 */
export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  /** The last event in the chain, or null if empty. */
  head(): Pick<BlackboxEvent, 'seq' | 'hash'> | null {
    const row = this.db
      .prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1')
      .get() as Pick<BlackboxEvent, 'seq' | 'hash'> | undefined;
    return row ?? null;
  }

  /** The persisted head anchor, or null if none has been written yet. */
  chainMeta(): ChainMeta | null {
    const row = this.db
      .prepare('SELECT count, head_seq, head_hash FROM chain_meta WHERE id = 1')
      .get() as ChainMeta | undefined;
    return row ?? null;
  }

  /**
   * Assign chain fields (seq, prev_hash, hash), append the event, and advance the
   * head anchor — all in one BEGIN IMMEDIATE transaction, so the head read, the
   * insert, and the anchor update are atomic even under concurrent writers.
   */
  append(e: NormalizedEvent): BlackboxEvent {
    const insertEvent = this.db.prepare(
      `INSERT INTO events
         (seq, event_id, session_id, tool_use_id, prompt_id, phase, hook_event,
          tool_name, action_type, target, agent_id, agent_type, cwd, permission_mode,
          success, duration_ms, ts, captured_at, raw, prev_hash, hash)
       VALUES
         (@seq, @event_id, @session_id, @tool_use_id, @prompt_id, @phase, @hook_event,
          @tool_name, @action_type, @target, @agent_id, @agent_type, @cwd, @permission_mode,
          @success, @duration_ms, @ts, @captured_at, @raw, @prev_hash, @hash)`,
    );
    const upsertMeta = this.db.prepare(
      `INSERT INTO chain_meta (id, count, head_seq, head_hash) VALUES (1, @count, @seq, @hash)
       ON CONFLICT(id) DO UPDATE SET count = @count, head_seq = @seq, head_hash = @hash`,
    );

    const tx = this.db.transaction((n: NormalizedEvent): BlackboxEvent => {
      const head = this.head();
      const seq = (head?.seq ?? 0) + 1;
      const prev_hash = head?.hash ?? GENESIS;

      // Everything except `hash`, in a fixed shape; canonical() sorts keys.
      const withoutHash = { ...sanitize(n), seq, prev_hash };
      const hash = hashEvent(withoutHash);
      const full: BlackboxEvent = { ...withoutHash, hash };

      insertEvent.run(full);
      upsertMeta.run({ count: seq, seq, hash });
      return full;
    });
    return tx.immediate(e);
  }

  /** All events in chain order. */
  all(): BlackboxEvent[] {
    return this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as BlackboxEvent[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
  }

  events(sessionId?: string): BlackboxEvent[] {
    if (sessionId) {
      return this.db
        .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC')
        .all(sessionId) as BlackboxEvent[];
    }
    return this.all();
  }

  sessions(): SessionSummary[] {
    return this.db
      .prepare(
        `SELECT session_id,
                COUNT(*)                                  AS events,
                MIN(ts)                                   AS started,
                MAX(ts)                                   AS ended,
                SUM(CASE WHEN phase = 'failure' THEN 1 ELSE 0 END) AS failures
         FROM events
         GROUP BY session_id
         ORDER BY started ASC`,
      )
      .all() as SessionSummary[];
  }

  close(): void {
    this.db.close();
  }
}
