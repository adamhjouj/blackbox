/**
 * R3 — chain-of-custody signing. Ed25519 (Node stdlib `crypto`, zero deps) over
 * the chain HEAD, so the tamper-*evidence* of the internal hash chain becomes
 * tamper-*resistance*: an attacker who rewrites the whole chain (events + the
 * same-file `chain_meta` anchor) still cannot forge a valid signature without the
 * private key, so `verify` catches the rewrite.
 *
 * Signatures are DERIVED from the immutable chain and stored OUTSIDE it (the
 * un-hashed `signatures` table). Signing never touches `events`/`chain_meta`, so
 * `verify()` is byte-identical before and after — same discipline as the risk
 * layer.
 *
 * A same-file `signatures` table is defeated by a local DB writer who simply
 * DELETES it (no private key needed), so signatures alone are not resistance. We
 * add a small OUT-OF-DB high-watermark file (`signing.head`, 0600) recording the
 * newest signed checkpoint; `verify` requires that checkpoint to still be present
 * and valid in the DB — so deletion / tail-rollback by a DB-only writer is caught.
 *
 * HONEST LIMIT (stated in the README + case-file): all of this is still LOCAL.
 * An attacker with full write access to ~/.blackbox (the DB *and* the key +
 * watermark files) can re-sign a rewrite. Detected: wrong-key re-signing, content
 * alteration at/below a signed head, and signature deletion/rollback by a writer
 * who cannot reach the watermark file. NOT resisted: a full-`~/.blackbox` writer.
 * TRUE off-machine resistance is the `--anchor` path (ship signed heads to a
 * remote append-only log) — a later/enterprise capability.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blackboxDir, ensureBlackboxDir } from './paths';
import type { SessionIdentityRow, SignatureRow, Store } from './store';

const PRIV_FILE = 'signing.key';
const PUB_FILE = 'signing.pub';
const HEAD_FILE = 'signing.head';

export interface Keypair {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** The out-of-DB high-watermark: the newest signed checkpoint. A DB-only attacker
 *  can't reach it, so verify() can detect signature deletion/rollback against it. */
export interface Watermark {
  seq: number;
  head_hash: string;
}

/** Generate an Ed25519 keypair once, persisted in ~/.blackbox (private key 0600).
 *  Idempotent — returns the existing pair if present. */
export function ensureKeypair(dir: string = ensureBlackboxDir()): Keypair {
  const privPath = join(dir, PRIV_FILE);
  const pubPath = join(dir, PUB_FILE);
  if (existsSync(privPath) && existsSync(pubPath)) {
    return { privateKeyPem: readFileSync(privPath, 'utf8'), publicKeyPem: readFileSync(pubPath, 'utf8') };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(privPath, privateKey, { mode: 0o600 });
  try {
    chmodSync(privPath, 0o600); // enforce even if the file pre-existed with other perms
  } catch {
    /* best-effort on non-POSIX */
  }
  writeFileSync(pubPath, publicKey);
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/** The trusted public key the user holds (signing.pub), or null if never keyed. */
export function loadPublicKey(dir: string = blackboxDir()): string | null {
  const pubPath = join(dir, PUB_FILE);
  try {
    return existsSync(pubPath) ? readFileSync(pubPath, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * AARM R6 — the stable identity of the RECORDER that produced a chain: a short
 * fingerprint of its Ed25519 public key. No new key material (the signing pair
 * already uniquely identifies an install), and it is safe to publish — it is a
 * hash of a public key, and it is what lets a third party holding an exported
 * session answer "which recorder attested to this?".
 */
export function recorderId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** Record the newest signed checkpoint out of band (0600) — the anti-deletion anchor. */
export function writeWatermark(dir: string, w: Watermark): void {
  const p = join(dir, HEAD_FILE);
  writeFileSync(p, JSON.stringify(w), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Load the high-watermark, or null if the store was never signed on this machine. */
export function loadWatermark(dir: string = blackboxDir()): Watermark | null {
  try {
    const p = join(dir, HEAD_FILE);
    if (!existsSync(p)) return null;
    const w = JSON.parse(readFileSync(p, 'utf8')) as Watermark;
    return typeof w?.seq === 'number' && typeof w?.head_hash === 'string' ? w : null;
  } catch {
    return null;
  }
}

/** Phases at which the daemon signs the head — session boundaries only, so the
 *  signature count stays bounded (~2/session). Exported so the gate is unit-testable. */
export function isSignableBoundary(phase: string): boolean {
  return phase === 'session_start' || phase === 'session_end' || phase === 'stop';
}

/** The exact bytes a checkpoint commits to — binds the head hash to its seq + time. */
export function checkpointMessage(seq: number, headHash: string, ts: string): Buffer {
  return Buffer.from(`blackbox-checkpoint\nseq=${seq}\nhead=${headHash}\nts=${ts}`, 'utf8');
}

export function signCheckpoint(seq: number, headHash: string, ts: string, privateKeyPem: string): string {
  return cryptoSign(null, checkpointMessage(seq, headHash, ts), privateKeyPem).toString('base64');
}

/** True iff `sigB64` is a valid Ed25519 signature over the checkpoint under `publicKeyPem`. */
export function verifyCheckpoint(seq: number, headHash: string, ts: string, sigB64: string, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(null, checkpointMessage(seq, headHash, ts), publicKeyPem, Buffer.from(sigB64, 'base64'));
  } catch {
    return false; // malformed key/signature → not valid, never throws into verify()
  }
}

/**
 * Sign the current chain head and persist the checkpoint. No-op on an empty chain
 * or when the current head is already signed. `nowIso` is passed in (no hidden
 * clock) so the daemon supplies wall-clock and tests stay deterministic.
 */
// ---- AARM R6: identity binding -------------------------------------------
//
// R6 wants every receipt cryptographically bound to an agent identity. `agent_id`
// and `agent_type` are already hashed columns, so the chain binds them TRANSITIVELY
// — but nothing says WHICH RECORDER produced the chain, so a third party holding an
// exported session cannot attribute it. The assertion below closes that: recorder R
// attests that events [first..last] of session S, ending at chain hash H, were
// produced by agent A.
//
// PURELY ADDITIVE BY CONSTRUCTION: it uses its own `blackbox-identity` message
// prefix, so it can never collide with `blackbox-checkpoint`. checkpointMessage()
// is untouched — changing it would invalidate every signature ever written.

export const IDENTITY_VERSION = 'v1';

/** The exact bytes an identity assertion commits to. Field order and the sorted
 *  agent list are fixed, so the same session always yields the same message. */
export function identityMessage(a: Omit<SessionIdentityRow, 'sig' | 'pubkey' | 'computed_at'>): Buffer {
  const agents = (JSON.parse(a.agent_ids) as string[]).slice().sort().join(',');
  return Buffer.from(
    `blackbox-identity\nv=${a.identity_version}\nsession=${a.session_id}\nrecorder=${a.recorder_id}\n` +
      `agent=${a.agent_type ?? ''}\nagents=${agents}\nrange=${a.first_seq}-${a.last_seq}\nhash=${a.head_hash}`,
    'utf8',
  );
}

/**
 * Build + sign the identity assertion for a session. Returns null when the session
 * has no events. Writes only the un-hashed `session_identity` table, so verify()
 * stays byte-identical.
 */
export function signIdentity(store: Store, sessionId: string, keys: Keypair, nowIso: string): SessionIdentityRow | null {
  const events = store.eventsLight(sessionId);
  if (!events.length) return null;
  const first = events[0]!;
  const last = events[events.length - 1]!;
  // agent_type is per-event (subagents differ), so the assertion names the session's
  // OWNING agent — the type on its first event — and lists every id seen alongside.
  const agentIds = [...new Set(events.map((e) => e.agent_id).filter((v): v is string => !!v))].sort();
  const unsigned = {
    session_id: sessionId,
    identity_version: IDENTITY_VERSION,
    recorder_id: recorderId(keys.publicKeyPem),
    agent_type: first.agent_type,
    agent_ids: JSON.stringify(agentIds),
    first_seq: first.seq,
    last_seq: last.seq,
    head_hash: last.hash,
  };
  const row: SessionIdentityRow = {
    ...unsigned,
    sig: cryptoSign(null, identityMessage(unsigned), keys.privateKeyPem).toString('base64'),
    pubkey: keys.publicKeyPem,
    computed_at: nowIso,
  };
  store.identityUpsert(row);
  return row;
}

/** True iff the assertion's signature is valid under `publicKeyPem`. Never throws. */
export function verifyIdentity(row: SessionIdentityRow, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(null, identityMessage(row), publicKeyPem, Buffer.from(row.sig, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Full check: the signature is valid AND the chain still says what the assertion
 * claims. A valid signature over a range whose head hash has since changed means
 * the record moved under the attestation — report it, don't silently pass.
 *
 * DERIVED DATA: a failure here is NOT a chain break. verify() must not consult this.
 */
export function checkIdentity(store: Store, row: SessionIdentityRow, publicKeyPem: string): { ok: boolean; reason: string | null } {
  if (!verifyIdentity(row, publicKeyPem)) return { ok: false, reason: 'signature-invalid' };
  const head = store.get(row.last_seq);
  if (!head) return { ok: false, reason: 'range-missing' };
  if (head.hash !== row.head_hash) return { ok: false, reason: 'range-hash-mismatch' };
  if (head.session_id !== row.session_id) return { ok: false, reason: 'range-session-mismatch' };
  return { ok: true, reason: null };
}

export function signHead(store: Store, keys: Keypair, nowIso: string): SignatureRow | null {
  const meta = store.chainMeta();
  if (!meta) return null;
  const latest = store.latestSignature();
  if (latest && latest.seq === meta.head_seq && latest.head_hash === meta.head_hash) return latest;
  const sig = signCheckpoint(meta.head_seq, meta.head_hash, nowIso, keys.privateKeyPem);
  const row: SignatureRow = { seq: meta.head_seq, head_hash: meta.head_hash, sig, pubkey: keys.publicKeyPem, ts: nowIso };
  store.signatureUpsert(row);
  return row;
}
