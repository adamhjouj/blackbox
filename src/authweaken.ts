/**
 * Semantic auth-weakening scanner. Runs at CAPTURE time in captureMutation() over
 * the ADDED side of a file_edit/file_write (the same place the diff content is in
 * hand), because the patch bytes live in the prunable `blobs` table and cannot be
 * re-scanned by the re-derivable risk layer later. Its result is persisted as a
 * FACT in the (hashed) `detail.mutation.weakens`, mirroring the injection scanner's
 * `detail.output_signals` — the risk layer only READS the stored fact, never
 * re-scans, so rescore stays byte-identical after a prune.
 *
 * This is the content-based complement to the path-based `auth-edit` flag: it fires
 * on an agent WEAKENING security (disabling TLS/signature verification, opening up
 * permissions/CORS, bypassing an auth check) — even in a file whose PATH looks
 * nothing like auth. Scored only under ruleset r4+ (auth-weaken flag).
 *
 * CEILING (stated, not hidden): this scans the NEW/added side only. Removing a
 * guard (deleting `@login_required` with no replacement) shows only as a `-` line
 * and is NOT detected here — a deliberate v1 cut (removal-vs-refactor is FP-prone).
 * ponytail: added-construct scan, add removed-guard diffing when field data justifies it.
 */
export const AUTH_WEAKEN_SCANNER_VERSION = 'aw1';

const MAX_SCAN = 64 * 1024;

// High-signal, low-ambiguity security downgrades. Each is a near-unambiguous
// "this makes the code less safe" construct, not a mere mention of a security topic.
const PATTERNS: [string, RegExp][] = [
  // TLS / certificate verification turned off.
  ['tls-verify-disabled', /\b(verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFY(PEER|HOST)\s*,\s*(0|false)|ssl\._create_unverified_context|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0)/],
  // Signature / JWT verification turned off, or the "none" algorithm accepted.
  ['signature-verify-disabled', /\b(verify_signature\s*[:=]\s*False|algorithms?\s*=\s*\[\s*['"]none['"]|['"]alg['"]\s*:\s*['"]none['"])/i],
  // Auth/permission requirement opened up (Django/DRF/Flask idioms).
  ['permission-open', /\b(AllowAny|permission_classes\s*=\s*\[\s*\]|AUTHENTICATION_CLASSES\s*=\s*\[\s*\]|@?csrf_exempt|WTF_CSRF_ENABLED\s*=\s*False|CSRF_(ENABLED|PROTECTION)\s*=\s*False)/],
  // CORS opened to any origin, or credentials allowed on a wildcard.
  ['cors-wildcard', /(Access-Control-Allow-Origin['"\s:=,()]+\*|origin\s*:\s*['"]\*['"]|Access-Control-Allow-Credentials['"\s:=,()]+true)/i],
  // An auth check short-circuited to always-allow, or explicitly disabled.
  ['auth-bypass', /\b(bypass[_-]?auth|skip[_-]?auth|disable[_-]?auth|no[_-]?auth\b|auth[_-]?disabled|SECURITY_DISABLED)/i],
  // SSH / host-key strictness disabled.
  ['hostkey-check-disabled', /\b(StrictHostKeyChecking[= ]+no|AutoAddPolicy|CheckHostIP[= ]+no)\b/i],
];

/** Scan added code for security-weakening constructs. Returns the matched pattern
 *  names (sorted, stable — the risk layer compares them across rescores), or null
 *  when nothing fired. Fixed-text/regex only: no filesystem/env resolution, so the
 *  fact is fully re-derivable from the stored diff. */
export function scanAuthWeaken(addedText: string): string[] | null {
  if (!addedText) return null;
  const scan = addedText.length > MAX_SCAN ? addedText.slice(0, MAX_SCAN) : addedText;
  const names = PATTERNS.filter(([, re]) => re.test(scan)).map(([id]) => id).sort();
  return names.length ? names : null;
}

/** The added/new side of a captured mutation: for a `body` write, the whole content;
 *  for a `patch`, only the inserted (`+`) lines (a removal is a `-` line — see the
 *  module ceiling). The leading marker is stripped so patterns match real code. */
export function addedSideOf(kind: 'patch' | 'body', content: string): string {
  if (kind === 'body') return content;
  const out: string[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('+')) out.push(line.slice(1));
  }
  return out.join('\n');
}
