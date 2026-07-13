/**
 * R6 — external anchoring (custody v2). Closes the honest limit of R3 signing:
 * an attacker with full `~/.blackbox` write access can re-sign a rewrite, because
 * the key + watermark live on the same machine. The fix is a signed head RECEIPT
 * placed somewhere that attacker can't reach — a second disk / synced folder, a
 * remote URL, or a dedicated git ref. Any ONE surviving receipt that no longer
 * matches the chain PROVES a rewrite (it can't be re-signed without the key).
 *
 * A receipt is exactly the R3 checkpoint tuple (seq, head_hash, ts, Ed25519 sig)
 * plus a version + key fingerprint — no new crypto. The daemon can emit one at the
 * same signable boundaries it already signs at; `blackbox anchor` emits on demand.
 *
 * This is the ONLY part of blackbox that can send bytes off the machine, and only
 * to an explicitly-configured `https:` target — off unless the user sets one.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { GIT_SAFE_FLAGS } from './git-safe';
import { hashString } from './hash';
import type { SignatureRow } from './store';

/** The ref a git-provider anchor writes its receipt chain to. Skipped by the git
 *  collector so anchoring a watched repo doesn't feed noise back into the chain. */
export const ANCHOR_REF = 'refs/blackbox/anchors';

/** A signed head receipt — the R3 checkpoint plus metadata, safe to place off-machine. */
export interface AnchorReceipt {
  v: 1;
  seq: number;
  head_hash: string;
  /** base64 Ed25519 signature over checkpointMessage(seq, head_hash, signed_at). */
  sig: string;
  /** short fingerprint of the signing public key — a cross-check, not the key itself. */
  pubkey_fp: string;
  /** the ISO timestamp bound into the signature (verifyCheckpoint needs it). */
  signed_at: string;
}

export type AnchorTarget =
  | { kind: 'file'; path: string }
  | { kind: 'https'; url: string }
  | { kind: 'git'; repo: string };

/** Parse a config target string: `file:<path>`, `git:<repo>`, or an http(s) URL. */
export function parseAnchorTarget(spec: string | null | undefined): AnchorTarget | null {
  if (!spec) return null;
  if (spec.startsWith('file:')) return { kind: 'file', path: spec.slice(5) };
  if (spec.startsWith('git:')) return { kind: 'git', repo: spec.slice(4) };
  if (/^https?:\/\//.test(spec)) return { kind: 'https', url: spec };
  return null;
}

/** Short, stable, human-comparable id for a PEM public key (matches report.ts). */
export function keyFingerprint(pem: string): string {
  return hashString(pem).replace('sha256:', '').slice(0, 16);
}

/** Turn the R3 signature row the daemon just wrote into an external receipt — the
 *  external artifact is byte-for-byte the same checkpoint, so it needs no re-signing. */
export function receiptFromSignature(row: SignatureRow): AnchorReceipt {
  return { v: 1, seq: row.seq, head_hash: row.head_hash, sig: row.sig, pubkey_fp: keyFingerprint(row.pubkey), signed_at: row.ts };
}

function git(repo: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', repo, ...GIT_SAFE_FLAGS, ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

/** Append the receipt to the git receipt chain on ANCHOR_REF (a parentless-rooted
 *  chain of one-file commits). Local-secondary by default — a custom ref doesn't
 *  ride `git push`; `blackbox anchor push` pushes it explicitly. */
function emitGit(repo: string, receipt: AnchorReceipt): void {
  const blob = git(repo, ['hash-object', '-w', '--stdin'], JSON.stringify(receipt) + '\n');
  const tree = git(repo, ['mktree'], `100644 blob ${blob}\treceipt.json\n`);
  let parent: string | null = null;
  try {
    parent = git(repo, ['rev-parse', '--verify', ANCHOR_REF]);
  } catch {
    /* first anchor — no parent */
  }
  const args = ['commit-tree', tree, '-m', `blackbox anchor seq=${receipt.seq} head=${receipt.head_hash}`];
  if (parent) args.push('-p', parent);
  const commit = git(repo, args);
  git(repo, ['update-ref', ANCHOR_REF, commit]);
}

/**
 * Emit a receipt to the configured target. `file`/`git` are synchronous and local;
 * `https` POSTs the receipt (the sole off-machine egress, opt-in only) with a short
 * timeout. Never throws into the caller — anchoring can never fail a recording.
 */
export async function emitReceipt(target: AnchorTarget, receipt: AnchorReceipt, opts: { token?: string | null } = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    if (target.kind === 'file') {
      appendFileSync(target.path, JSON.stringify(receipt) + '\n');
      return { ok: true };
    }
    if (target.kind === 'git') {
      emitGit(target.repo, receipt);
      return { ok: true };
    }
    // https — the only path that leaves the machine.
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(target.url, { method: 'POST', headers, body: JSON.stringify(receipt), signal: AbortSignal.timeout(2000) });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Read back the receipts a target holds. `file`/`git` are locally readable; `https`
 *  receipts live on the remote and are verified out-of-band, so this returns []. */
export function readReceipts(target: AnchorTarget): AnchorReceipt[] {
  try {
    if (target.kind === 'file') {
      if (!existsSync(target.path)) return [];
      return readFileSync(target.path, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as AnchorReceipt)
        .filter((r) => r && r.v === 1 && typeof r.seq === 'number');
    }
    if (target.kind === 'git') {
      let head: string;
      try {
        head = git(target.repo, ['rev-parse', '--verify', ANCHOR_REF]);
      } catch {
        return [];
      }
      const out: AnchorReceipt[] = [];
      for (const sha of git(target.repo, ['rev-list', head]).split('\n').filter(Boolean)) {
        try {
          out.push(JSON.parse(git(target.repo, ['show', `${sha}:receipt.json`])) as AnchorReceipt);
        } catch {
          /* skip an unreadable/legacy commit */
        }
      }
      return out;
    }
    return []; // https: receipts are remote, verified out-of-band
  } catch {
    return [];
  }
}
