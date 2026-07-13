import Database from 'better-sqlite3';
import { GENESIS, hashEvent } from './hash';
import type { BlobInput } from './mutation';
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

/**
 * Content-addressed mutation EVIDENCE. NOT part of the hash chain: the immutable
 * event commits to `content_hash` (in its hashed `detail.mutation`), and the bytes
 * live here keyed by that same hash — self-verifying (bytes must hash to their key)
 * and prunable. `verify()` reads only `events`+`chain_meta`, never this table, so
 * dropping content is byte-identical to the chain. `prune` nulls `content` and sets
 * `pruned_at`, keeping the row as a tombstone (hash+size+diffstat survive forever).
 */
const BLOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  content_hash TEXT    NOT NULL PRIMARY KEY,
  content      TEXT,
  bytes        INTEGER NOT NULL,
  encoding     TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  pruned_at    TEXT
);
`;

/**
 * R3 chain-of-custody. Ed25519 signatures over the chain HEAD — DERIVED from the
 * immutable chain and stored OUTSIDE it. Signing never touches events/chain_meta,
 * so verify() is byte-identical before/after. verify() reads this table only when
 * given a trusted public key, so existing callers are unaffected.
 */
const SIG_SCHEMA = `
CREATE TABLE IF NOT EXISTS signatures (
  seq        INTEGER NOT NULL,
  head_hash  TEXT    NOT NULL,
  sig        TEXT    NOT NULL,
  pubkey     TEXT    NOT NULL,
  ts         TEXT    NOT NULL,
  PRIMARY KEY (seq, head_hash)
);
`;

/**
 * R2 reconciliation = a SEPARATE re-derivable interpretation, like risk. It joins
 * the captured git worktree_delta fact against the hook mutations and records
 * discrepancy findings + coverage. Never part of the hash chain; recomputable via
 * `blackbox reconcile`, so verify() is byte-identical.
 */
const RECON_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_reconciliation (
  session_id      TEXT    NOT NULL,
  ruleset_version TEXT    NOT NULL,
  corroborated    INTEGER NOT NULL,
  finding_count   INTEGER NOT NULL,
  findings        TEXT    NOT NULL,
  coverage        TEXT    NOT NULL,
  last_seq        INTEGER NOT NULL,
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

export interface BlobRow {
  content_hash: string;
  /** Redacted patch/body bytes; null once pruned (the row survives as a tombstone). */
  content: string | null;
  bytes: number;
  encoding: string;
  created_at: string;
  pruned_at: string | null;
}

/** A signed chain-of-custody checkpoint (R3): Ed25519 signature over the head. */
export interface SignatureRow {
  seq: number;
  head_hash: string;
  sig: string;
  pubkey: string;
  ts: string;
}

/** A session's R2 reconciliation verdict (re-derivable, un-hashed). */
export interface SessionReconciliationRow {
  session_id: string;
  ruleset_version: string;
  corroborated: number;
  finding_count: number;
  findings: string; // JSON Discrepancy[]
  coverage: string; // JSON Coverage
  last_seq: number;
  computed_at: string;
}

export interface SessionSummary {
  session_id: string;
  events: number;
  started: string;
  ended: string;
  failures: number;
  /** Events that are NOT bare session-lifecycle markers (SessionStart/SessionEnd):
   *  tool use, Stop (a completed turn), or subagent activity. 0 ⇒ the session
   *  recorded no chat at all — opened but never used. */
  activity: number;
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
    // Read the on-disk schema version BEFORE any exec/ALTER. A newer blackbox may
    // have written a hash-format this build can't reproduce; touching it (even a
    // metadata-only ADD COLUMN) then re-stamping the version would mask the
    // mismatch and could break verify(). Refuse instead. (user_version is 0 on a
    // fresh or legacy DB — both are safely stamped to SCHEMA_VERSION below.)
    const onDisk = this.db.pragma('user_version', { simple: true });
    if (typeof onDisk === 'number' && onDisk > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `blackbox: the store at ${path} is schema version ${onDisk}, but this build only understands ${SCHEMA_VERSION}. ` +
          `It was written by a newer blackbox — upgrade this install instead of risking a hash-format mismatch.`,
      );
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.ensureColumns();
    this.db.exec(RISK_SCHEMA);
    this.db.exec(BLOB_SCHEMA);
    this.db.exec(SIG_SCHEMA);
    this.db.exec(RECON_SCHEMA);
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
   * Assign chain fields (seq, prev_hash, hash), append the event, advance the head
   * anchor, and (optionally) persist the mutation-evidence blob — all in one BEGIN
   * IMMEDIATE transaction. The blob is content-addressed (INSERT OR IGNORE dedupes
   * identical bodies), and its key equals `detail.mutation.content_hash` because
   * both come from the same captureMutation() call. The blob is a separate,
   * un-hashed row; it never enters the chain, so verify() is unaffected by it.
   */
  append(e: NormalizedEvent, blob?: BlobInput | null): BlackboxEvent {
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
    const insertBlob = this.db.prepare(
      `INSERT OR IGNORE INTO blobs (content_hash, content, bytes, encoding, created_at)
       VALUES (@content_hash, @content, @bytes, @encoding, @created_at)`,
    );

    const tx = this.db.transaction((n: NormalizedEvent, b: BlobInput | null): BlackboxEvent => {
      const head = this.head();
      const seq = (head?.seq ?? 0) + 1;
      const prev_hash = head?.hash ?? GENESIS;

      // Everything except `hash`, in a fixed shape; canonical() sorts keys.
      const withoutHash = { ...sanitize(n), seq, prev_hash };
      const hash = hashEvent(withoutHash);
      const full: BlackboxEvent = { ...withoutHash, hash };

      insertEvent.run(full);
      upsertMeta.run({ count: seq, seq, hash });
      if (b) insertBlob.run({ content_hash: b.content_hash, content: b.content, bytes: b.bytes, encoding: b.encoding, created_at: full.captured_at });
      return full;
    });
    return tx.immediate(e, blob ?? null);
  }

  /** All events in chain order. */
  all(): BlackboxEvent[] {
    return this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as BlackboxEvent[];
  }

  /** Stream every event in chain order without materialising the whole chain —
   *  constant memory for verify() on a large store (the full chain includes the
   *  heavy `raw` column). Holds a read transaction for the life of the iterator. */
  *iterateAll(): Generator<BlackboxEvent> {
    yield* this.db.prepare('SELECT * FROM events ORDER BY seq ASC').iterate() as IterableIterator<BlackboxEvent>;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
  }

  /** One event by its chain position, or null. */
  get(seq: number): BlackboxEvent | null {
    return (this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq) as BlackboxEvent | undefined) ?? null;
  }

  /** The Post/Failure event paired with a Pre by `tool_use_id` — the phase that
   *  carries the outcome (mutation fact, timing). Lets the dossier for a Pre row
   *  surface the diff, which lives on its Post sibling. Uses idx_events_tooluse. */
  postFor(toolUseId: string, afterSeq: number): BlackboxEvent | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM events WHERE tool_use_id = ? AND seq > ? AND (phase = 'post' OR phase = 'failure')
             ORDER BY seq ASC LIMIT 1`,
        )
        .get(toolUseId, afterSeq) as BlackboxEvent | undefined) ?? null
    );
  }

  /** R2: the session's START HEAD (from the SessionStart git anchor), or null when
   *  the session wasn't anchored (no cwd / not a repo). The reconciliation base. */
  sessionBaseSha(sessionId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT json_extract(detail, '$.anchor.head_sha') AS sha
           FROM events WHERE session_id = ? AND phase = 'session_start' AND detail LIKE '%anchor%'
          ORDER BY seq ASC LIMIT 1`,
      )
      .get(sessionId) as { sha: string | null } | undefined;
    return row?.sha ?? null;
  }

  /** R2: has a worktree delta already been captured for this session? (SessionEnd
   *  can fire more than once — keep one WorktreeDelta event per session.) */
  worktreeDeltaExists(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE session_id = ? AND hook_event = 'WorktreeDelta' LIMIT 1").get(sessionId);
  }

  /** R2: has the SessionStart dirty-baseline already been captured for this session? */
  worktreeBaseExists(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE session_id = ? AND hook_event = 'WorktreeBase' LIMIT 1").get(sessionId);
  }

  /** R1: has a reasoning digest already been captured for this turn? (Stop can
   *  fire more than once — this keeps one reasoning event per prompt_id.) */
  reasoningExists(sessionId: string, promptId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM events WHERE session_id = ? AND prompt_id = ? AND hook_event = 'ReasoningCapture' LIMIT 1")
      .get(sessionId, promptId);
  }

  /** The transcript file path for a session (from any event's payload) — lets the
   *  read layer resolve the human-readable session name. */
  sessionTranscriptPath(sessionId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT json_extract(raw, '$.transcript_path') AS tp
           FROM events WHERE session_id = ? AND raw LIKE '%transcript_path%' LIMIT 1`,
      )
      .get(sessionId) as { tp: string | null } | undefined;
    return row?.tp ?? null;
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

  // ---- chain-of-custody signatures (R3) ----------------------------------

  signatureUpsert(r: SignatureRow): void {
    this.db
      .prepare(
        `INSERT INTO signatures (seq, head_hash, sig, pubkey, ts)
         VALUES (@seq, @head_hash, @sig, @pubkey, @ts)
         ON CONFLICT(seq, head_hash) DO UPDATE SET sig=@sig, pubkey=@pubkey, ts=@ts`,
      )
      .run(r);
  }

  /** All signed checkpoints in chain order. */
  signatures(): SignatureRow[] {
    return this.db.prepare('SELECT * FROM signatures ORDER BY seq ASC').all() as SignatureRow[];
  }

  /** The most recent signed checkpoint, or null. */
  latestSignature(): SignatureRow | null {
    return (this.db.prepare('SELECT * FROM signatures ORDER BY seq DESC LIMIT 1').get() as SignatureRow | undefined) ?? null;
  }

  // ---- R2 reconciliation layer -------------------------------------------

  reconciliationUpsert(r: SessionReconciliationRow): void {
    this.db
      .prepare(
        `INSERT INTO session_reconciliation
           (session_id, ruleset_version, corroborated, finding_count, findings, coverage, last_seq, computed_at)
         VALUES (@session_id, @ruleset_version, @corroborated, @finding_count, @findings, @coverage, @last_seq, @computed_at)
         ON CONFLICT(session_id, ruleset_version) DO UPDATE SET
           corroborated=@corroborated, finding_count=@finding_count, findings=@findings,
           coverage=@coverage, last_seq=@last_seq, computed_at=@computed_at`,
      )
      .run(r);
  }

  sessionReconciliation(sessionId: string, ruleset: string): SessionReconciliationRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM session_reconciliation WHERE session_id = ? AND ruleset_version = ?')
        .get(sessionId, ruleset) as SessionReconciliationRow | undefined) ?? null
    );
  }

  reconciliationDelete(ruleset: string, sessionId?: string): void {
    if (sessionId) this.db.prepare('DELETE FROM session_reconciliation WHERE ruleset_version = ? AND session_id = ?').run(ruleset, sessionId);
    else this.db.prepare('DELETE FROM session_reconciliation WHERE ruleset_version = ?').run(ruleset);
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

  // ---- mutation evidence blobs (content-addressed, prunable) --------------

  /** The stored content for a mutation, or null if unknown. A row with content=null
   *  is a tombstone (pruned): the commitment (hash/size) survives, the bytes are gone. */
  blobGet(hash: string): BlobRow | null {
    return (this.db.prepare('SELECT * FROM blobs WHERE content_hash = ?').get(hash) as BlobRow | undefined) ?? null;
  }

  /** Total blob rows, including pruned tombstones. */
  blobCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM blobs').get() as { c: number }).c;
  }

  /** Blob rows that still hold content (not yet pruned). */
  blobLiveCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM blobs WHERE content IS NOT NULL').get() as { c: number }).c;
  }

  /**
   * Retention: drop the CONTENT of mutation blobs older than the cutoff, keeping
   * each row as a tombstone (hash+size+pruned_at) and the events + chain untouched
   * — so `verify()` is byte-identical before and after. A blob is pruned only when
   * NO event at/after the cutoff still references its hash (content-addressed dedupe
   * means one body can be shared across time; a still-live reference protects it).
   */
  prune(cutoffIso: string, prunedAtIso: string): { pruned: number; bytesFreed: number } {
    const tx = this.db.transaction((cutoff: string, prunedAt: string) => {
      // Hashes still referenced by an event at/after the cutoff — these are kept.
      const live = new Set(
        (
          this.db
            .prepare(
              `SELECT DISTINCT json_extract(detail, '$.mutation.content_hash') AS ch
                 FROM events
                WHERE ts >= ? AND json_extract(detail, '$.mutation.content_hash') IS NOT NULL`,
            )
            .all(cutoff) as { ch: string | null }[]
        )
          .map((r) => r.ch)
          .filter((x): x is string => !!x),
      );
      const candidates = this.db.prepare('SELECT content_hash, bytes FROM blobs WHERE content IS NOT NULL').all() as {
        content_hash: string;
        bytes: number;
      }[];
      const drop = this.db.prepare('UPDATE blobs SET content = NULL, pruned_at = ? WHERE content_hash = ?');
      let pruned = 0;
      let bytesFreed = 0;
      for (const c of candidates) {
        if (live.has(c.content_hash)) continue;
        drop.run(prunedAt, c.content_hash);
        pruned++;
        bytesFreed += c.bytes;
      }
      return { pruned, bytesFreed };
    });
    return tx(cutoffIso, prunedAtIso);
  }

  sessions(): SessionSummary[] {
    return this.db
      .prepare(
        `SELECT session_id,
                COUNT(*)                                  AS events,
                MIN(ts)                                   AS started,
                MAX(ts)                                   AS ended,
                SUM(CASE WHEN phase = 'failure' THEN 1 ELSE 0 END) AS failures,
                SUM(CASE WHEN phase NOT IN ('session_start','session_end') THEN 1 ELSE 0 END) AS activity
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
