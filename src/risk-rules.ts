import { createHash } from 'node:crypto';
import { isSensitivePath } from './redact-rules';
import type { BlackboxEvent } from './types';

/** Ruleset version. Bump when rules/scores/thresholds change; old versions stay
 *  scoreable/reproducible via `blackbox rescore --ruleset`. r1 tables are FROZEN;
 *  r2 recalibrates scores (secret-touch/new-mcp → 0) and adds the injected-* and
 *  tool-poisoning combos. */
export type RulesetVersion = 'r1' | 'r2';
export const RULESET_VERSION: RulesetVersion = 'r2';

/** Numeric ruleset compare — a string compare gets 'r10' < 'r2' wrong. */
export function rulesetNum(v: string): number {
  const m = /^r(\d+)$/.exec(v);
  return m ? Number(m[1]) : 0;
}

/** The rulesets this build can compute. Anything else must be rejected before
 *  scoring (an unknown ruleset has no score table → a crash, and its fingerprint
 *  would silently collide with r2). */
export const KNOWN_RULESETS: RulesetVersion[] = ['r1', 'r2'];
export function isKnownRuleset(v: string): v is RulesetVersion {
  return (KNOWN_RULESETS as string[]).includes(v);
}

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

/** Two flag classes drive presentation + scoring under r2. RISK_FLAGS paint the
 *  timeline red and score >0; ANNOTATION_FLAGS are combo fuel / muted context
 *  (score 0). This split is what kills the per-event chip noise (secret-touch
 *  fired 345x) while keeping every combo antecedent fully intact. */
export const RISK_FLAGS = new Set<FlagId>(['dangerous-shell', 'auth-edit', 'mass-diff', 'destructive-git']);
export const ANNOTATION_FLAGS = new Set<FlagId>(['secret-touch', 'external-send', 'new-mcp-server', 'injection-output', 'failed']);
/** Annotations that stay visible as a MUTED (non-red) chip even off a combo seq —
 *  an outbound send or a detected injection is never silently invisible. */
export const ALWAYS_SHOW_ANNOTATIONS = new Set<FlagId>(['external-send', 'new-mcp-server', 'injection-output']);
export const isAnnotation = (f: FlagId): boolean => ANNOTATION_FLAGS.has(f);

/** Version-dispatched scores. r1 is frozen; r2 demotes secret-touch and
 *  new-mcp-server to 0 (annotations) — combos key off flag PRESENCE, so firing is
 *  unaffected. The 'auth-edit-test'/'mass-diff-bulk' keys are score variants
 *  selected inside evaluateEvent. */
type ScoreKey = FlagId | 'auth-edit-test' | 'mass-diff-bulk';
const SCORES_R1: Record<ScoreKey, number> = {
  'secret-touch': 30, 'dangerous-shell': 60, 'auth-edit': 50, 'auth-edit-test': 25,
  'mass-diff': 50, 'mass-diff-bulk': 60, 'new-mcp-server': 20, 'destructive-git': 25,
  'external-send': 0, 'injection-output': 0, failed: 0,
};
const SCORES: Record<RulesetVersion, Record<ScoreKey, number>> = {
  r1: SCORES_R1,
  r2: { ...SCORES_R1, 'secret-touch': 0, 'new-mcp-server': 0 },
};

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

// r2 rm: same recursive+force detection, but fire ONLY on catastrophic targets —
// bare root/home/cwd wipes, shallow (<=2 segment) absolute system/home roots,
// sensitive ~ / $HOME children, and VCS dirs. Deep project/cache/build paths and
// /tmp scratchpads are safe (this clears all 84 observed dangerous-shell FPs).
function blankQuotes(s: string): string {
  return s.replace(/'[^']*'|"[^"]*"/g, (m) => ' '.repeat(m.length)); // length-preserving
}
const TMP_ROOT = /^\/(private\/)?(tmp|var\/folders|var\/tmp)(\/|$)/i;
const REL_CATASTROPHIC = new Set(['.git', '.svn', '.hg']);
const SENSITIVE_HOME_CHILD = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.gcloud', '.azure', '.netrc', '.npmrc']);
const HOME_ROOT = /^(~|\$\{?HOME\}?|\$\{?PWD\}?)(\/(.*))?$/i;
const RM_RECURSIVE = /(^|\s)-{1,2}[a-z]*r|--recursive\b/i;
const RM_FORCE = /(^|\s)-{1,2}[a-z]*f|--force\b/i;
// First path segment of an absolute target that is system- or home-owned — a
// shallow recursive wipe of one of these is catastrophic. A first segment NOT in
// this set (e.g. /app, /data) is treated as an app dir: a deep wipe like
// `rm -rf /app/node_modules` is routine and must NOT fire.
const SYSTEM_ROOT_SEG = new Set(['etc', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'boot', 'dev', 'sys', 'proc', 'root', 'var', 'opt', 'srv', 'private', 'system', 'library', 'applications', 'volumes', 'users', 'home']);
// Deep-but-catastrophic prefixes: a wipe anywhere beneath them fires at any depth.
const CATASTROPHIC_PREFIX = ['var/lib', 'usr/local', 'var/www'];

function rmTokenDangerous(rawTok: string): boolean {
  const t = rawTok.replace(/^['"]|['"]$/g, '');
  if (!t) return false;
  if (/^(\/|~|~\/|\*|\.|\.\/|\.\/\*|\.\.|\.\.\/|\.\.\/\*|\/\*)$/.test(t)) return true; // bare root/home/cwd/glob
  const rel = t.replace(/^\.\//, '').replace(/\/+$/, '');
  if (REL_CATASTROPHIC.has(rel)) return true; // rm -rf .git
  const hm = HOME_ROOT.exec(t);
  if (hm) {
    const sub = (hm[3] ?? '').replace(/\/+$/, '');
    return sub === '' || SENSITIVE_HOME_CHILD.has(sub.split('/')[0] ?? '');
  }
  if (t.startsWith('/')) {
    if (TMP_ROOT.test(t)) return false; // scratch dirs, any depth
    const segs = t.replace(/\/+$/, '').replace(/\/\*$/, '').split('/').filter(Boolean);
    if (segs.length <= 1) return true; // bare top-level dir wipe (/, /app, /data …)
    if (CATASTROPHIC_PREFIX.includes(segs.slice(0, 2).join('/').toLowerCase())) return true; // /var/lib/mysql, /usr/local/bin …
    return segs.length <= 2 && SYSTEM_ROOT_SEG.has((segs[0] ?? '').toLowerCase()); // shallow system/home root
  }
  return false;
}
function rmDangerous(cmd: string): boolean {
  const blanked = blankQuotes(cmd);
  const re = /\brm\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    const start = m.index;
    const stopRel = blanked.slice(start).search(/[|&;\n]/);
    const end = stopRel > -1 ? start + stopRel : blanked.length;
    if (!RM_RECURSIVE.test(blanked.slice(start, end)) || !RM_FORCE.test(blanked.slice(start, end))) continue;
    // read the target from the ORIGINAL span so a quoted REAL target survives
    const toks = cmd.slice(start, end).split(/\s+/).slice(1).filter((x) => x && !x.startsWith('-'));
    if (toks.some(rmTokenDangerous)) return true;
  }
  return false;
}

function isDangerousShell(cmd: string, rs: RulesetVersion): boolean {
  if (rs === 'r1') {
    const c = stripQuotes(cmd); // ignore dangerous literals that are only quoted data
    return PIPE_TO_SHELL.some((re) => re.test(c)) || CHMOD_OPEN.test(c) || rmDestructive(c);
  }
  const c = blankQuotes(cmd);
  return PIPE_TO_SHELL.some((re) => re.test(c)) || CHMOD_OPEN.test(c) || rmDangerous(cmd);
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
// injected-tamper uses a STRONGER auth predicate: it drops the ambiguous,
// high-churn 'middleware'|'guard' segments (they still earn a per-event auth-edit
// chip, but must not alone promote an injection pairing to a HIGH tamper combo).
const AUTH_SEGMENT_STRONG =
  /(^|[/_.\-])(auth[nz]?|authorize|authorization|login|logout|password|passwd|jwt|oauth|oidc|sso|saml|credential|credentials|rbac|acl|iam|keycloak)(?=$|[/_.\-])/i;
export function isStrongAuthPath(p: string): boolean {
  return AUTH_SEGMENT_STRONG.test(p);
}
export function isTestPath(p: string): boolean {
  return TEST_PATH.test(p);
}
// CI/build config an injected instruction would target for a persistent backdoor.
const CI_BUILD_PATH =
  /(^|\/)\.github\/workflows\/|(^|\/)\.circleci\/|(^|\/)(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|\.drone\.yml|package\.json|Makefile|setup\.py|pyproject\.toml)$/i;
export function isCiBuildPath(p: string): boolean {
  return CI_BUILD_PATH.test(p);
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

// ---- injected-tamper antecedent (provenance-gated) -----------------------
/** The tamper antecedent arms ONLY from output that arrived on an UNTRUSTED
 *  external channel — a web fetch or an MCP tool response. An agent READING a
 *  local file that merely contains an injection string, or a shell echo of one,
 *  never arms (kills the meta-FP of doing injection work on this very repo). */
export function isUntrustedOutputChannel(e: BlackboxEvent): boolean {
  return e.action_type === 'web_fetch' || e.action_type === 'mcp_call';
}
// Imperative, low-collision markers — any ONE arms.
export const TAMPER_ARM_STRONG = ['ignore-instructions', 'disregard', 'override-safety', 'conceal-from-user'];
// Ambiguous with benign RBAC/onboarding English — need >=2 distinct arming markers.
export const TAMPER_ARM_CORROBORATE = ['you-are-now', 'new-instructions'];
/** Whether captured injection pattern names arm the tamper antecedent, given the
 *  channel they arrived on. Selects among already-captured i1 names — never
 *  re-scans output. A web page commonly QUOTES an injection string (security
 *  articles, this project's own docs), so a `web_fetch` needs corroboration (>=2
 *  distinct arming markers); MCP tool output is more clearly untrusted, so one
 *  strong marker arms. */
export function armsTamper(patterns: string[], channel: string): boolean {
  const s = new Set(patterns);
  const strong = TAMPER_ARM_STRONG.filter((p) => s.has(p)).length;
  const corrob = TAMPER_ARM_CORROBORATE.filter((p) => s.has(p)).length;
  if (channel === 'web_fetch') return strong + corrob >= 2;
  return strong >= 1 || strong + corrob >= 2;
}
/** The first sensitive local file referenced by an MCP call's OUTBOUND tool_input
 *  (its `target` is the JSON.stringify'd input). Powers the tool-poisoning data
 *  link: a poisoned server shipping a file the session already read. */
export function mcpOutboundSensitiveFile(e: BlackboxEvent): string | null {
  return e.action_type === 'mcp_call' ? commandReadsSensitiveFile(e.target ?? '') : null;
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

/** Evaluate one event. Feed a session's events in seq order (ctx tracks MCP
 *  servers). Scores are version-dispatched: under r2, secret-touch and
 *  new-mcp-server score 0 (annotations) but still HIT — combos key off presence. */
export function evaluateEvent(e: BlackboxEvent, ctx: SessionRuleCtx, rs: RulesetVersion = RULESET_VERSION): RuleHit[] {
  const hits: RuleHit[] = [];
  const sc = SCORES[rs];
  const cmd = e.target ?? '';

  if (e.phase === 'failure') hits.push({ flag: 'failed', score: sc.failed });

  if (e.redaction_count > 0) hits.push({ flag: 'secret-touch', score: sc['secret-touch'] });
  else if (/^file_(read|write|edit)$/.test(e.action_type) && cmd && isSensitivePath(cmd))
    hits.push({ flag: 'secret-touch', score: sc['secret-touch'], evidence: { path: cmd } });
  else if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && cmd) {
    const sf = commandReadsSensitiveFile(cmd); // cat/base64 .env, curl -d @secret, etc.
    if (sf) hits.push({ flag: 'secret-touch', score: sc['secret-touch'], evidence: { path: sf } });
  }

  if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && cmd && isDangerousShell(cmd, rs))
    hits.push({ flag: 'dangerous-shell', score: sc['dangerous-shell'] });

  if ((e.action_type === 'file_write' || e.action_type === 'file_edit') && cmd && isAuthPath(cmd))
    hits.push({ flag: 'auth-edit', score: TEST_PATH.test(cmd) ? sc['auth-edit-test'] : sc['auth-edit'], evidence: { path: cmd } });

  const detail = parseDetail(e);
  const git = detail?.git as { is_force?: boolean; is_reset?: boolean; is_delete?: boolean; diffstat?: { files: number; insertions: number; deletions: number } } | undefined;
  if (git && (git.is_force || git.is_reset || git.is_delete)) hits.push({ flag: 'destructive-git', score: sc['destructive-git'] });
  if (git?.diffstat) {
    const { files, insertions, deletions } = git.diffstat;
    if (deletions >= 500 && deletions > 3 * insertions) hits.push({ flag: 'mass-diff', score: sc['mass-diff-bulk'], evidence: { ...git.diffstat, kind: 'bulk-delete' } });
    else if (files >= 25 || insertions + deletions >= 1500) hits.push({ flag: 'mass-diff', score: sc['mass-diff'], evidence: git.diffstat });
  }
  if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && GIT_DESTRUCTIVE.some((re) => re.test(cmd)) && !hits.some((h) => h.flag === 'destructive-git'))
    hits.push({ flag: 'destructive-git', score: sc['destructive-git'] });

  if (e.tool_name?.startsWith('mcp__')) {
    const server = e.tool_name.split('__')[1] ?? '';
    if (server && !ctx.seenMcp.has(server)) {
      ctx.seenMcp.add(server);
      hits.push({ flag: 'new-mcp-server', score: sc['new-mcp-server'], evidence: { server } });
    }
  }

  const send = isExternalSend(e);
  if (send) hits.push({ flag: 'external-send', score: sc['external-send'], evidence: { ...send } });

  // A captured FACT (score 0): the heuristic injection scanner is unvalidated, so
  // it never inflates a verdict on its own — the injected-* combos (risk-engine)
  // are the only thing that turns it into signal, and only on an untrusted channel.
  const inj = (detail?.output_signals as { injection?: string[] } | undefined)?.injection;
  if (inj?.length) hits.push({ flag: 'injection-output', score: sc['injection-output'], evidence: { patterns: inj } });

  return hits;
}

/** Fingerprint of the exact rule table — stored on each verdict so a report is
 *  pinned to a reproducible computation. Version-keyed: the r1 spec object is
 *  FROZEN byte-for-byte, so stored r1 rows' rules_hash still validates after the
 *  r2 bump. */
export function rulesFingerprint(ruleset: RulesetVersion = RULESET_VERSION): string {
  const sha = (spec: unknown): string => 'sha256:' + createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  const r1spec = {
    version: 'r1',
    scores: { 'secret-touch': 30, 'dangerous-shell': 60, 'auth-edit': 50, 'auth-edit-test': 25, 'mass-diff': 50, 'mass-diff-bulk': 60, 'new-mcp-server': 20, 'destructive-git': 25, 'injection-output': 0, 'external-send': 0, failed: 0 },
    thresholds: { massDiffFiles: 25, massDiffLines: 1500, bulkDelDeletions: 500, bulkDelRatio: 3, queryPayloadMinLen: 40, exfilTemporalWindow: 20 },
    combos: { 'exfil-chain': { dataLinked: 'high', temporal: 'medium' } },
    verdict: { comboWeight: 40, highScore: 80, medScore: 50 },
  };
  if (ruleset === 'r1') return sha(r1spec);
  const r2spec = {
    version: 'r2',
    scores: { 'secret-touch': 0, 'dangerous-shell': 60, 'auth-edit': 50, 'auth-edit-test': 25, 'mass-diff': 50, 'mass-diff-bulk': 60, 'new-mcp-server': 0, 'destructive-git': 25, 'injection-output': 0, 'external-send': 0, failed: 0 },
    thresholds: { massDiffFiles: 25, massDiffLines: 1500, bulkDelDeletions: 500, bulkDelRatio: 3, queryPayloadMinLen: 40, exfilTemporalWindow: 20, tamperWindow: 20, dangerousShellRm: 'target-scoped' },
    combos: {
      'exfil-chain': { dataLinked: 'high', temporal: 'medium' },
      'injected-tamper': { auth: 'high', authTest: 'medium' },
      'injected-exfil': { push: 'high' },
      'injected-rce': { shell: 'high' },
      'injected-ci-write': { ci: 'high' },
      'tool-poisoning': { dataLinked: 'high', firstContact: 'medium-disabled' },
    },
    strongInjection: { arm: TAMPER_ARM_STRONG, corroborate: TAMPER_ARM_CORROBORATE, untrustedChannels: ['web_fetch', 'mcp_call'], webFetchNeedsCorroboration: true },
    verdict: { comboWeight: 40, highScore: 80, medScore: 50 },
  };
  return sha(r2spec);
}
