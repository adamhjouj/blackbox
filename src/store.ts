import Database from 'better-sqlite3';
import { GENESIS, hashEvent } from './hash';
import { EVENT_COLUMNS, type BlackboxEvent, type NormalizedEvent } from './types';

/** Current schema/hash-format version. Bump on any breaking hash-format change. */
const SCHEMA_VERSION = 1;

/** Every event column except the heavy `raw`, for the read/UI path. */
const LIGHT_COLUMNS = EVENT_COLUMNS.filter((c) => c !== 'raw').join(', ');

/** SQLite column type for each event column (used by ensureColumns migration). */
const COLUMN_TYPES: Record<string, string> = {
  seq: 'INTEGER',
  event_id: 'TEXT',
  session_id: 'TEXT',
  tool_use_id: 'TEXT',
  prompt_id: 'TEXT',
  phase: 'TEXT',
  hook_event: 'TEXT',
  tool_name: 'TEXT',
  action_type: 'TEXT',
  target: 'TEXT',
  agent_id: 'TEXT',
  agent_type: 'TEXT',
  cwd: 'TEXT',
  permission_mode: 'TEXT',
  success: 'INTEGER',
  duration_ms: 'INTEGER',
  ts: 'TEXT',
  captured_at: 'TEXT',
  raw: 'TEXT',
  output_hash: 'TEXT',
  output_size_bytes: 'INTEGER',
  redaction_count: 'INTEGER',
  detail: 'TEXT',
  prev_hash: 'TEXT',
  hash: 'TEXT',
};

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
  output_hash        TEXT,
  output_size_bytes  INTEGER,
  redaction_count    INTEGER NOT NULL DEFAULT 0,
  detail             TEXT,
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

/**
 * Phase 3 risk = a SEPARATE interpretation layer, NOT part of the hash chain.
 * Its integrity comes from being fully re-derivable from the immutable events
 * (blackbox rescore --check). Editing/rescoring never touches events/chain_meta,
 * so verify() is byte-identical before and after.
 */
const RISK_SCHEMA = `
CREATE TABLE IF NOT EXISTS risk (
  seq             INTEGER NOT NULL,
  ruleset_version TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  score           INTEGER NOT NULL,
  flags           TEXT    NOT NULL,
  evidence        TEXT,
  computed_at     TEXT    NOT NULL,
  PRIMARY KEY (seq, ruleset_version)
);
CREATE INDEX IF NOT EXISTS idx_risk_session ON risk(session_id, ruleset_version, seq);

CREATE TABLE IF NOT EXISTS session_risk (
  session_id      TEXT    NOT NULL,
  ruleset_version TEXT    NOT NULL,
  verdict         TEXT    NOT NULL,
  score           INTEGER NOT NULL,
  combos          TEXT,
  rule_counts     TEXT    NOT NULL,
  last_scored_seq INTEGER NOT NULL,
  rules_hash      TEXT    NOT NULL,
  computed_at     TEXT    NOT NULL,
  PRIMARY KEY (session_id, ruleset_version)
);
`;

export interface ChainMeta {
  count: number;
  head_seq: number;
  head_hash: string;
}

export interface RiskRow {
  seq: number;
  ruleset_version: string;
  session_id: string;
  score: number;
  flags: string;
  evidence: string | null;
  computed_at: string;
}

export interface SessionRiskRow {
  session_id: string;
  ruleset_version: string;
  verdict: string;
  score: number;
  combos: string | null;
  rule_counts: string;
  last_scored_seq: number;
  rules_hash: string;
  computed_at: string;
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
    this.ensureColumns();
    this.db.exec(RISK_SCHEMA);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Additively migrate an older store: add any expected column that a
   * previously-created DB is missing. SQLite ADD COLUMN is O(1) metadata-only.
   * Safe for the hash chain because canonical() omits null keys, so a column
   * that is null on old rows does not change their hash.
   */
  private ensureColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of EVENT_COLUMNS) {
      if (existing.has(col)) continue;
      const type = COLUMN_TYPES[col] ?? 'TEXT';
      this.db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
    }
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
    // INSERT column list is derived from EVENT_COLUMNS so it can never drift
    // from the schema / hashed column set.
    const insertEvent = this.db.prepare(
      `INSERT INTO events (${EVENT_COLUMNS.join(', ')})
       VALUES (${EVENT_COLUMNS.map((c) => '@' + c).join(', ')})`,
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

  /** One event by its chain position, or null. */
  get(seq: number): BlackboxEvent | null {
    return (this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq) as BlackboxEvent | undefined) ?? null;
  }

  events(sessionId?: string): BlackboxEvent[] {
    if (sessionId) {
      return this.db
        .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC')
        .all(sessionId) as BlackboxEvent[];
    }
    return this.all();
  }

  /**
   * Like events() but WITHOUT the heavy `raw` column — for the read/UI path,
   * which needs only normalized fields + `detail` for signals. Cuts read-path
   * memory by the size of the (potentially multi-MB) raw payloads.
   */
  eventsLight(sessionId?: string): BlackboxEvent[] {
    const cols = LIGHT_COLUMNS;
    if (sessionId) {
      return this.db
        .prepare(`SELECT ${cols} FROM events WHERE session_id = ? ORDER BY seq ASC`)
        .all(sessionId) as BlackboxEvent[];
    }
    return this.db.prepare(`SELECT ${cols} FROM events ORDER BY seq ASC`).all() as BlackboxEvent[];
  }

  // ---- risk interpretation layer (Phase 3) -------------------------------

  riskUpsert(r: RiskRow): void {
    this.db
      .prepare(
        `INSERT INTO risk (seq, ruleset_version, session_id, score, flags, evidence, computed_at)
         VALUES (@seq, @ruleset_version, @session_id, @score, @flags, @evidence, @computed_at)
         ON CONFLICT(seq, ruleset_version) DO UPDATE SET
           score=@score, flags=@flags, evidence=@evidence, computed_at=@computed_at`,
      )
      .run(r);
  }

  riskForSession(sessionId: string, ruleset: string): RiskRow[] {
    return this.db
      .prepare('SELECT * FROM risk WHERE session_id = ? AND ruleset_version = ? ORDER BY seq ASC')
      .all(sessionId, ruleset) as RiskRow[];
  }

  sessionRiskUpsert(r: SessionRiskRow): void {
    this.db
      .prepare(
        `INSERT INTO session_risk
           (session_id, ruleset_version, verdict, score, combos, rule_counts, last_scored_seq, rules_hash, computed_at)
         VALUES
           (@session_id, @ruleset_version, @verdict, @score, @combos, @rule_counts, @last_scored_seq, @rules_hash, @computed_at)
         ON CONFLICT(session_id, ruleset_version) DO UPDATE SET
           verdict=@verdict, score=@score, combos=@combos, rule_counts=@rule_counts,
           last_scored_seq=@last_scored_seq, rules_hash=@rules_hash, computed_at=@computed_at`,
      )
      .run(r);
  }

  sessionRisk(sessionId: string, ruleset: string): SessionRiskRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM session_risk WHERE session_id = ? AND ruleset_version = ?')
        .get(sessionId, ruleset) as SessionRiskRow | undefined) ?? null
    );
  }

  sessionRiskAll(ruleset: string): SessionRiskRow[] {
    return this.db.prepare('SELECT * FROM session_risk WHERE ruleset_version = ?').all(ruleset) as SessionRiskRow[];
  }

  /** Delete a ruleset's risk rows (whole ruleset, or one session of it). */
  riskDelete(ruleset: string, sessionId?: string): void {
    const tx = this.db.transaction((rs: string, sid?: string) => {
      if (sid) {
        this.db.prepare('DELETE FROM risk WHERE ruleset_version = ? AND session_id = ?').run(rs, sid);
        this.db.prepare('DELETE FROM session_risk WHERE ruleset_version = ? AND session_id = ?').run(rs, sid);
      } else {
        this.db.prepare('DELETE FROM risk WHERE ruleset_version = ?').run(rs);
        this.db.prepare('DELETE FROM session_risk WHERE ruleset_version = ?').run(rs);
      }
    });
    tx(ruleset, sessionId);
  }

  /** Session ids that have events but no up-to-date verdict for `ruleset`. */
  unscoredSessions(ruleset: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT e.session_id AS session_id, MAX(e.seq) AS max_seq
             FROM events e
             LEFT JOIN session_risk r ON r.session_id = e.session_id AND r.ruleset_version = ?
            GROUP BY e.session_id
           HAVING r.last_scored_seq IS NULL OR r.last_scored_seq < MAX(e.seq)`,
        )
        .all(ruleset) as { session_id: string }[]
    ).map((r) => r.session_id);
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
