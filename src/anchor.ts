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
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { GIT_SAFE_FLAGS } from './git-safe';
import { hashString } from './hash';
import { configPath } from './paths';
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

const execFileP = promisify(execFile);

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
export async function emitReceipt(target: AnchorTarget, receipt: AnchorReceipt, opts: { token?: string | null; push?: boolean } = {}): Promise<{ ok: boolean; error?: string; warn?: string }> {
  try {
    if (target.kind === 'file') {
      appendFileSync(target.path, JSON.stringify(receipt) + '\n');
      return { ok: true };
    }
    if (target.kind === 'git') {
      emitGit(target.repo, receipt);
      // Default-on external anchoring pushes the receipt ref off-machine. A push
      // failure (offline / no remote) must NOT discard the receipt we just wrote to
      // the local ref — surface it as a warning, keep the local emit successful.
      if (opts.push) {
        try {
          await pushGitAnchor(target.repo);
        } catch (err) {
          return { ok: true, warn: `git anchor push failed: ${(err as Error).message}` };
        }
      }
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

/** The anchor target + optional bearer token from `~/.blackbox/config.json`, plus
 *  the derived posture: whether a git anchor auto-pushes (default on — the point of
 *  default-on anchoring; disable with `anchor_push:false` for a local-secondary ref),
 *  and whether the user explicitly accepted the reduced-security local-only mode. */
export function loadAnchorConfig(cfgPath: string = configPath()): { target: AnchorTarget | null; token: string | null; push: boolean; localOnly: boolean } {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { anchor?: string; anchor_token?: string; anchor_push?: boolean; anchor_local_only?: boolean };
    const target = parseAnchorTarget(cfg.anchor);
    const push = target?.kind === 'git' && cfg.anchor_push !== false;
    return { target, token: typeof cfg.anchor_token === 'string' ? cfg.anchor_token : null, push, localOnly: cfg.anchor_local_only === true };
  } catch {
    return { target: null, token: null, push: false, localOnly: false };
  }
}

/** Persist an anchor target into config.json (validating it first). Returns the
 *  parsed target so the caller can act on it. Throws on an unrecognised spec. */
export function setAnchorTarget(spec: string, cfgPath: string = configPath()): AnchorTarget {
  const target = parseAnchorTarget(spec);
  if (!target) throw new Error(`invalid anchor target "${spec}" — use file:<path>, git:<repo>, or https://<url>`);
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh/absent config */
  }
  cfg.anchor = spec;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return target;
}

/** Mark (or clear) the explicit reduced-security "local-only" custody posture in
 *  config — receipts stay on this machine. Recorded so `status`/reports can warn
 *  that off-machine tamper-evidence is OFF as an ACKNOWLEDGED choice, not a silent
 *  one. Anchoring on by default means this flag should be the exception. */
export function setAnchorLocalOnly(on: boolean, cfgPath: string = configPath()): void {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh/absent config */
  }
  if (on) cfg.anchor_local_only = true;
  else delete cfg.anchor_local_only;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

/** Push the git receipt ref to the repo's default remote — the one explicit step
 *  that takes a local-secondary git anchor off-machine (custom refs don't auto-push).
 *  Async + hard-bounded: `git push` is a network op, and running it via the sync
 *  `git()` helper on the daemon's single event loop froze every hook behind a slow or
 *  hung remote. `execFile` yields the loop while git runs; `timeout` SIGKILLs a wedged
 *  push instead of blocking forever.
 *  ponytail: 15s cap — raise if a legit remote is genuinely slower than that. */
export async function pushGitAnchor(repo: string): Promise<void> {
  await execFileP('git', ['-C', repo, ...GIT_SAFE_FLAGS, 'push', 'origin', `${ANCHOR_REF}:${ANCHOR_REF}`], {
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
}

/** Best-effort: the top-level of the git repo containing `cwd`, or null if `cwd`
 *  isn't inside a work tree. */
export function repoTopOf(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']) || null;
  } catch {
    return null;
  }
}

/** The push URL of the repo's default remote (`origin`, else the first remote), or
 *  null if the repo has no remote configured. */
export function repoRemoteUrl(repo: string): string | null {
  try {
    const remotes = git(repo, ['remote'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!remotes.length) return null;
    const name = remotes.includes('origin') ? 'origin' : remotes[0]!;
    return git(repo, ['remote', 'get-url', name]) || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the DEFAULT external anchor for `blackbox init`: a git receipt-ref anchor
 * on the repo containing `cwd`, but ONLY if that repo has a remote to push receipts
 * to (somewhere genuinely off-machine). Returns null when `cwd` isn't a git repo or
 * the repo has no remote — the caller must then FAIL LOUDLY rather than silently
 * degrade to local-only custody.
 */
export function resolveDefaultAnchor(cwd: string): { spec: string; repo: string; remote: string } | null {
  const repo = repoTopOf(cwd);
  if (!repo) return null;
  const remote = repoRemoteUrl(repo);
  if (!remote) return null;
  return { spec: `git:${repo}`, repo, remote };
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
