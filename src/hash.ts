import { createHash } from 'node:crypto';

/** The prev_hash of the very first event. */
export const GENESIS = 'sha256:' + '0'.repeat(64);

/**
 * Deterministic JSON serialization: object keys are recursively sorted so the
 * same logical record always produces the same bytes (and therefore the same
 * hash), independent of insertion order or how SQLite hands the row back.
 *
 * Object keys whose value is null/undefined are OMITTED. This makes the schema
 * extensible: adding a new nullable column is hash-neutral for every row that
 * does not populate it, so `verify` never false-positives after an additive
 * migration. (Array elements keep their nulls — positions are significant.)
 * A column whose value actually changes to/from null still changes the hash,
 * so tamper detection is unaffected.
 */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== null && obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/**
 * Hash a record consisting of all persisted columns EXCEPT `hash`. Because the
 * record includes `prev_hash`, each event's hash is bound to the entire history
 * before it — altering, deleting, or reordering any event breaks every hash
 * that follows.
 */
export function hashEvent(recordWithoutHash: Record<string, unknown>): string {
  return hashString(canonical(recordWithoutHash));
}

/** sha256 of a UTF-8 string, prefixed. Used for output/field hashing in redaction. */
export function hashString(s: string): string {
  return 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');
}
