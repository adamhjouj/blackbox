import { createHash } from 'node:crypto';
import { isSensitivePath } from './redact-rules';
import type { BlackboxEvent } from './types';

/** Ruleset version. Bump when rules/scores/thresholds change; old versions stay
 *  scoreable/reproducible via `blackbox rescore --ruleset`. */
export const RULESET_VERSION = 'r1';

export type FlagId =
  | 'secret-touch'
  | 'dangerous-shell'
  | 'auth-edit'
  | 'mass-diff'
  | 'new-mcp-server'
  | 'failed'
  | 'destructive-git'
  | 'external-send'
  | 'injection-output';

export interface RuleHit {
  flag: FlagId;
  score: number;
  evidence?: Record<string, unknown>;
}

/** Per-session state a rule needs (superset of Phase-2 SignalCtx). */
export interface SessionRuleCtx {
  seenMcp: Set<string>;
}
export function newRuleCtx(): SessionRuleCtx {
  return { seenMcp: new Set() };
}

// ---- dangerous-shell predicates ------------------------------------------
// Any pipe/process-substitution/command-substitution of a downloaded body into
// an interpreter (not just an adjacent single pipe to sh/bash).
const INTERP = '(sh|bash|zsh|python3?|node|nodejs|perl|ruby|eval)';
const PIPE_TO_SHELL = [
  new RegExp('\\b(curl|wget)\\b[^;|&]*\\|\\s*(sudo\\s+)?' + INTERP + '\\b', 'i'),
  new RegExp('\\bbase64\\s+-d[^;|&]*\\|\\s*' + INTERP + '\\b', 'i'),
  new RegExp(INTERP + '\\s+<\\(\\s*(curl|wget)\\b', 'i'), // bash <(curl …)
];
const CHMOD_OPEN = /\bchmod\s+(-R\s+|-\w+\s+)*(0?777|a=?\+?rwx|ugo\+rwx)\b/i;

/** Blank out quoted regions so a command that merely CONTAINS a dangerous literal
 *  (grep "rm -rf", echo 'curl|sh') isn't treated as executing it. */
function stripQuotes(cmd: string): string {
  return cmd.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

/** The first sensitive-path file the command reads (a `@file`/`< file`, or a
 *  bare sensitive-path token). Used for secret-touch on shell reads and for the
 *  data-linked exfil combo. */
export function commandReadsSensitiveFile(cmd: string): string | null {
  for (const tok of cmd.split(/[\s"'|;&><()=]+/)) {
    const p = tok.replace(/^@/, '');
    if (p && isSensitivePath(p)) return p;
  }
  return null;
}
const GIT_DESTRUCTIVE = [
  /\bgit\b[^"'|]*\bpush\b[^"'|]*(--force\b|--force-with-lease\b|-f\b)/i,
  /\bgit\b[^"'|]*\breset\b[^"'|]*--hard\b/i,
  /\bgit\b[^"'|]*\bbranch\b[^"'|]*-D\b/i,
  /\bgit\b[^"'|]*\bclean\b[^"'|]*-[a-z]*f/i,
];
function rmDestructive(cmd: string): boolean {
  const i = cmd.search(/\brm\b/);
  if (i < 0) return false;
  const rest = cmd.slice(i);
  const stop = rest.search(/[|&;\n]/);
  const seg = stop > -1 ? rest.slice(0, stop) : rest;
  return (/(^|\s)-{1,2}[a-z]*r|--recursive\b/i.test(seg)) && (/(^|\s)-{1,2}[a-z]*f|--force\b/i.test(seg));
}
function isDangerousShell(cmd: string): boolean {
  const c = stripQuotes(cmd); // ignore dangerous literals that are only quoted data
  return PIPE_TO_SHELL.some((re) => re.test(c)) || CHMOD_OPEN.test(c) || rmDestructive(c);
}

// ---- auth path (segment boundary, Tier 1) --------------------------------
// Strong, low-ambiguity auth segments only. The bare words token/session/
// permission were dropped (design tokens, lexer tokens, analytics sessions look
// like auth files); authorize/middleware/guard/rbac/password added for recall.
const AUTH_SEGMENT =
  /(^|[/_.\-])(auth[nz]?|authorize|authorization|login|logout|password|passwd|jwt|oauth|oidc|sso|saml|credential|credentials|rbac|acl|iam|middleware|guard|keycloak)(?=$|[/_.\-])/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|fixtures|mocks?)(\/)/i;
export function isAuthPath(p: string): boolean {
  return AUTH_SEGMENT.test(p);
}

// ---- external send (the exfil-chain consequent) --------------------------
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    /^(localhost|::1|0\.0\.0\.0)$/.test(h) ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith('.local')
  );
}
const HAS_DATA_FLAG = /(-d\b|--data(-binary|-raw|-urlencode)?\b|--post-file\b|--post-data\b|-F\b|--form\b|-T\b|--upload-file\b|-X\s+(POST|PUT|PATCH)\b)/i;
// A scripting one-liner making a network call (python/node/perl/ruby exfil).
const SCRIPT_NET = /\b(python3?|node|nodejs|perl|ruby)\b[^;|&]*(-c|-e|-E)\b[^;|&]*(urlopen|urllib|requests\.|https?\.request|\bfetch\(|Net::HTTP|open-uri|socket\.|smtplib)/i;
// Bare domain token (host without scheme — curl auto-prepends http://).
const DOMAIN = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?/gi;
const FILEISH = /\.(txt|json|md|ts|tsx|js|jsx|py|sh|env|pem|key|log|csv|ya?ml|lock|conf|toml|ini|xml|html)$/i;

export type SendVia = 'curl-data' | 'pipe-file' | 'script' | 'query-payload' | 'netcat' | 'scp' | 'mcp-url';
export interface ExternalSend {
  via: SendVia;
  host: string;
  /** a sensitive file the sending command reads → the send carries a secret. */
  secret?: string;
}
/** True for the "push" sends where a temporal secret-touch→send combo is meaningful. */
export const PUSH_SENDS: SendVia[] = ['curl-data', 'pipe-file', 'script', 'netcat', 'scp'];

function externalUrlHosts(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/https?:\/\/([^/\s"'|)>]+)/gi)) {
    const h = ((m[1] ?? '').split('@').pop() ?? '').replace(/:\d+$/, '');
    if (h && !isLocalHost(h)) out.push(h);
  }
  return out;
}
function externalDomainHosts(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(DOMAIN)) {
    const h = (m[1] ?? '').replace(/:\d+$/, '');
    if (h && !isLocalHost(h) && !FILEISH.test(h)) out.push(h);
  }
  return out;
}

/** Detection of an outbound *data-bearing* send to a non-local host. A plain doc
 *  GET is deliberately NOT a send. `secret` is set when the sending command reads
 *  a sensitive file (the data-flow signal that makes the exfil combo HIGH). */
export function isExternalSend(e: BlackboxEvent): ExternalSend | null {
  const t = e.target ?? '';

  if (e.action_type === 'shell_command' || e.action_type === 'git_action') {
    const secret = commandReadsSensitiveFile(t) ?? undefined;
    const host = (): string | undefined => externalUrlHosts(t)[0] ?? externalDomainHosts(t)[0];

    // data-bearing curl/wget (scheme'd OR scheme-less host)
    if (/\b(curl|wget)\b/i.test(t) && HAS_DATA_FLAG.test(t)) {
      const h = host();
      if (h) return { via: 'curl-data', host: h, secret };
    }
    // a file piped into curl/wget to an external host
    if (/\|\s*(curl|wget)\b/i.test(t)) {
      const h = host();
      if (h) return { via: 'pipe-file', host: h, secret };
    }
    // scripting-language network send
    if (SCRIPT_NET.test(t)) {
      const h = host();
      if (h) return { via: 'script', host: h, secret };
    }
    // query-payload GET (≥40-char query) to an external host
    for (const m of t.matchAll(/https?:\/\/([^/\s"'|)>]+)(\/[^\s"'|)>]*)?/gi)) {
      const hh = ((m[1] ?? '').split('@').pop() ?? '').replace(/:\d+$/, '');
      const path = m[2] ?? '';
      const qi = path.indexOf('?');
      if (hh && !isLocalHost(hh) && qi > -1 && path.length - qi - 1 >= 40) return { via: 'query-payload', host: hh, secret };
    }
    // netcat / scp / rsync / sftp (with optional user@)
    const nc = t.match(/\b(?:nc|ncat|netcat)\s+(?:-\S+\s+)*([a-z0-9.\-]+)\s+\d+/i);
    if (nc?.[1] && !isLocalHost(nc[1])) return { via: 'netcat', host: nc[1], secret };
    const scp = t.match(/\b(?:scp|rsync|sftp)\b[^|]*?\s(?:[a-z0-9._-]+@)?([a-z0-9.\-]+):[^\s]/i);
    if (scp?.[1] && !isLocalHost(scp[1])) return { via: 'scp', host: scp[1], secret };
    return null;
  }

  if (e.action_type === 'web_fetch') {
    for (const m of t.matchAll(/https?:\/\/([^/\s"']+)(\/[^\s"']*)?/gi)) {
      const host = (m[1] ?? '').replace(/:\d+$/, '');
      const path = m[2] ?? '';
      const qi = path.indexOf('?');
      if (host && !isLocalHost(host) && qi > -1 && path.length - qi - 1 >= 40) return { via: 'query-payload', host };
    }
    return null;
  }

  if (e.action_type === 'mcp_call') {
    const m = t.match(/https?:\/\/([^/\s"']+)/i);
    const host = (m?.[1] ?? '').replace(/:\d+$/, '');
    if (host && !isLocalHost(host)) return { via: 'mcp-url', host };
    return null;
  }
  return null;
}

// ---- per-event evaluation ------------------------------------------------
function parseDetail(e: BlackboxEvent): Record<string, unknown> | null {
  if (!e.detail) return null;
  try {
    return JSON.parse(e.detail) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Evaluate one event. Feed a session's events in seq order (ctx tracks MCP servers). */
export function evaluateEvent(e: BlackboxEvent, ctx: SessionRuleCtx): RuleHit[] {
  const hits: RuleHit[] = [];
  const cmd = e.target ?? '';

  if (e.phase === 'failure') hits.push({ flag: 'failed', score: 0 });

  if (e.redaction_count > 0) hits.push({ flag: 'secret-touch', score: 30 });
  else if (/^file_(read|write|edit)$/.test(e.action_type) && cmd && isSensitivePath(cmd))
    hits.push({ flag: 'secret-touch', score: 30, evidence: { path: cmd } });
  else if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && cmd) {
    const sf = commandReadsSensitiveFile(cmd); // cat/base64 .env, curl -d @secret, etc.
    if (sf) hits.push({ flag: 'secret-touch', score: 30, evidence: { path: sf } });
  }

  if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && cmd && isDangerousShell(cmd))
    hits.push({ flag: 'dangerous-shell', score: 60 });

  if ((e.action_type === 'file_write' || e.action_type === 'file_edit') && cmd && isAuthPath(cmd))
    hits.push({ flag: 'auth-edit', score: TEST_PATH.test(cmd) ? 25 : 50, evidence: { path: cmd } });

  const detail = parseDetail(e);
  const git = detail?.git as { is_force?: boolean; is_reset?: boolean; is_delete?: boolean; diffstat?: { files: number; insertions: number; deletions: number } } | undefined;
  if (git && (git.is_force || git.is_reset || git.is_delete)) hits.push({ flag: 'destructive-git', score: 25 });
  if (git?.diffstat) {
    const { files, insertions, deletions } = git.diffstat;
    if (deletions >= 500 && deletions > 3 * insertions) hits.push({ flag: 'mass-diff', score: 60, evidence: { ...git.diffstat, kind: 'bulk-delete' } });
    else if (files >= 25 || insertions + deletions >= 1500) hits.push({ flag: 'mass-diff', score: 50, evidence: git.diffstat });
  }
  if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && GIT_DESTRUCTIVE.some((re) => re.test(cmd)) && !hits.some((h) => h.flag === 'destructive-git'))
    hits.push({ flag: 'destructive-git', score: 25 });

  if (e.tool_name?.startsWith('mcp__')) {
    const server = e.tool_name.split('__')[1] ?? '';
    if (server && !ctx.seenMcp.has(server)) {
      ctx.seenMcp.add(server);
      hits.push({ flag: 'new-mcp-server', score: 20, evidence: { server } });
    }
  }

  const send = isExternalSend(e);
  if (send) hits.push({ flag: 'external-send', score: 0, evidence: { ...send } });

  // Captured as a fact now, but scored 0 in r1: the heuristic injection scanner
  // is unvalidated, so it must not inflate verdicts until the injected-tamper
  // combo work (the circle-back) validates and scores it.
  const inj = (detail?.output_signals as { injection?: string[] } | undefined)?.injection;
  if (inj?.length) hits.push({ flag: 'injection-output', score: 0, evidence: { patterns: inj } });

  return hits;
}

/** Fingerprint of the exact rule table — stored on each verdict so a report is
 *  pinned to a reproducible computation. */
export function rulesFingerprint(): string {
  const spec = {
    version: RULESET_VERSION,
    scores: { 'secret-touch': 30, 'dangerous-shell': 60, 'auth-edit': 50, 'auth-edit-test': 25, 'mass-diff': 50, 'mass-diff-bulk': 60, 'new-mcp-server': 20, 'destructive-git': 25, 'injection-output': 0, 'external-send': 0, failed: 0 },
    thresholds: { massDiffFiles: 25, massDiffLines: 1500, bulkDelDeletions: 500, bulkDelRatio: 3, queryPayloadMinLen: 40, exfilTemporalWindow: 20 },
    combos: { 'exfil-chain': { dataLinked: 'high', temporal: 'medium' } },
    verdict: { comboWeight: 40, highScore: 80, medScore: 50 },
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}
