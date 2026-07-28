/**
 * Project-local expectations for the Review Inbox.
 *
 * A baseline changes presentation only: a matching finding is labelled
 * `expected`, never removed from the result set and never removed from the
 * immutable evidence chain. Policies are deliberately small, versioned JSON so
 * a typo cannot silently turn into a broad suppression rule.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { canonical, hashString } from './hash';

export const BASELINE_POLICY_VERSION = 1 as const;
export const MAX_BASELINE_POLICY_BYTES = 64 * 1024;

const MAX_ENTRIES = 128;
const MAX_PATTERNS_PER_SELECTOR = 64;
const MAX_PATTERN_POINTS = 512;
const MAX_REASON_POINTS = 1000;

export const BASELINE_SELECTOR_KEYS = [
  'finding_ids',
  'rule_ids',
  'hosts',
  'paths',
  'command_prefixes',
  'mcp_servers',
] as const;

export type BaselineSelectorKey = (typeof BASELINE_SELECTOR_KEYS)[number];

export interface BaselineSelectors {
  finding_ids?: string[];
  rule_ids?: string[];
  hosts?: string[];
  paths?: string[];
  command_prefixes?: string[];
  mcp_servers?: string[];
}

/** Every populated selector category is required; values within one category
 * are alternatives. For example, a rule with `rule_ids` and `paths` matches a
 * finding only when both a rule id AND a path match. */
export interface BaselineEntry extends BaselineSelectors {
  id: string;
  reason: string;
}

export interface BaselinePolicyV1 {
  version: typeof BASELINE_POLICY_VERSION;
  expected: BaselineEntry[];
}

export interface LoadedBaselinePolicy {
  path: string;
  policy: BaselinePolicyV1;
  /** Hash of the normalized semantic policy, not filesystem whitespace/order. */
  hash: string;
}

/** The safe, already-normalized fields a policy may inspect. No raw hook bytes
 * or tool output are accepted here, so matching cannot leak raw evidence. */
export interface BaselineSubject {
  finding_id: string;
  rule_ids: readonly string[];
  hosts: readonly string[];
  paths: readonly string[];
  commands: readonly string[];
  mcp_servers: readonly string[];
}

export interface BaselineMatch {
  id: string;
  reason: string;
}

export class BaselinePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselinePolicyError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function points(value: string): number {
  return Array.from(value).length;
}

function fail(message: string): never {
  throw new BaselinePolicyError(message);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) fail(`${at} contains unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
}

function parsePatterns(value: unknown, at: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${at} must be an array of strings`);
  if (!value.length) fail(`${at} must not be empty`);
  if (value.length > MAX_PATTERNS_PER_SELECTOR) fail(`${at} has more than ${MAX_PATTERNS_PER_SELECTOR} patterns`);

  const out = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const pattern = value[i];
    if (typeof pattern !== 'string') fail(`${at}[${i}] must be a string`);
    const normalized = pattern.trim();
    if (!normalized) fail(`${at}[${i}] must not be blank`);
    if (points(normalized) > MAX_PATTERN_POINTS) fail(`${at}[${i}] exceeds ${MAX_PATTERN_POINTS} characters`);
    if (normalized.includes('\0')) fail(`${at}[${i}] must not contain NUL`);
    out.add(normalized);
  }
  return [...out].sort();
}

function parseEntry(value: unknown, index: number): BaselineEntry {
  const at = `expected[${index}]`;
  if (!isRecord(value)) fail(`${at} must be an object`);
  assertKnownKeys(value, ['id', 'reason', ...BASELINE_SELECTOR_KEYS], at);

  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.id)) {
    fail(`${at}.id must be 1-80 letters, numbers, dots, underscores, or dashes`);
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) fail(`${at}.reason must be a non-empty string`);
  const reason = value.reason.trim();
  if (points(reason) > MAX_REASON_POINTS) fail(`${at}.reason exceeds ${MAX_REASON_POINTS} characters`);

  const selectors: BaselineSelectors = {};
  for (const key of BASELINE_SELECTOR_KEYS) {
    const parsed = parsePatterns(value[key], `${at}.${key}`);
    if (parsed) selectors[key] = parsed;
  }
  if (!BASELINE_SELECTOR_KEYS.some((key) => selectors[key]?.length)) {
    fail(`${at} must define at least one selector`);
  }
  return { id: value.id, reason, ...selectors };
}

/** Parse and normalize a policy. Invalid/unknown versions and fields fail
 * closed instead of quietly creating a broader baseline than the author meant. */
export function parseBaselinePolicy(value: string | unknown): BaselinePolicyV1 {
  let decoded: unknown = value;
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(value) as unknown;
    } catch (error) {
      fail(`invalid JSON: ${(error as Error).message}`);
    }
  }
  if (!isRecord(decoded)) fail('policy must be a JSON object');
  assertKnownKeys(decoded, ['version', 'expected'], 'policy');
  if (decoded.version !== BASELINE_POLICY_VERSION) {
    fail(`unsupported policy version ${JSON.stringify(decoded.version)}; expected ${BASELINE_POLICY_VERSION}`);
  }
  if (!Array.isArray(decoded.expected)) fail('policy.expected must be an array');
  if (decoded.expected.length > MAX_ENTRIES) fail(`policy.expected has more than ${MAX_ENTRIES} entries`);

  const entries = decoded.expected.map(parseEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) fail(`duplicate baseline id: ${entry.id}`);
    seen.add(entry.id);
  }
  // Deliberately avoid localeCompare: policy hashes must not depend on the
  // machine's ICU locale/version.
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: BASELINE_POLICY_VERSION, expected: entries };
}

/** Reordering object keys, entries, or selector alternatives does not change the
 * policy fingerprint. This is useful in attestations and stale-review checks. */
export function baselinePolicyHash(policy: BaselinePolicyV1): string {
  const normalized = parseBaselinePolicy(policy);
  return hashString(`blackbox-baseline-policy-v1\n${canonical(normalized)}`);
}

function errno(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errno(error) === 'ENOENT') return null;
    throw error;
  }
}

/** Read `<repo>/.blackbox/policy.json` without following a symlink at either
 * project-policy path component. Missing policy files are normal and return null. */
export function loadBaselinePolicy(
  repoRoot: string,
  options: { maxBytes?: number } = {},
): LoadedBaselinePolicy | null {
  const maxBytes = options.maxBytes ?? MAX_BASELINE_POLICY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('maxBytes must be a positive integer');

  const policyDir = join(repoRoot, '.blackbox');
  const policyPath = join(policyDir, 'policy.json');
  let dirStat: Stats | null;
  let fileStat: Stats | null;
  try {
    dirStat = statOrNull(policyDir);
    if (!dirStat) return null;
    if (dirStat.isSymbolicLink()) fail(`${policyDir} is a symlink; refusing project policy`);
    if (!dirStat.isDirectory()) fail(`${policyDir} is not a directory`);

    fileStat = statOrNull(policyPath);
    if (!fileStat) return null;
    if (fileStat.isSymbolicLink()) fail(`${policyPath} is a symlink; refusing project policy`);
    if (!fileStat.isFile()) fail(`${policyPath} is not a regular file`);
    if (fileStat.size > maxBytes) fail(`${policyPath} exceeds the ${maxBytes}-byte policy limit`);
  } catch (error) {
    if (error instanceof BaselinePolicyError) throw error;
    fail(`cannot inspect ${policyPath}: ${(error as Error).message}`);
  }

  let fd: number;
  try {
    // O_NOFOLLOW closes the lstat/open race on platforms that provide it.
    fd = openSync(policyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    fail(`cannot open ${policyPath}: ${(error as Error).message}`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) fail(`${policyPath} is not a regular file`);
    if (opened.size > maxBytes) fail(`${policyPath} exceeds the ${maxBytes}-byte policy limit`);
    const raw = readFileSync(fd);
    if (raw.byteLength > maxBytes) fail(`${policyPath} exceeds the ${maxBytes}-byte policy limit`);
    const policy = parseBaselinePolicy(raw.toString('utf8'));
    return { path: policyPath, policy, hash: baselinePolicyHash(policy) };
  } catch (error) {
    if (error instanceof BaselinePolicyError) throw error;
    fail(`cannot read ${policyPath}: ${(error as Error).message}`);
  } finally {
    closeSync(fd);
  }
}

function hasGlob(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

function globSource(pattern: string, pathMode: boolean): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pathMode && pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += pathMode ? '[^/]*' : '.*';
      }
    } else if (char === '?') {
      out += pathMode ? '[^/]' : '.';
    } else {
      out += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return out;
}

function scalarMatch(candidate: string, pattern: string, insensitive = false): boolean {
  const flags = insensitive ? 'i' : '';
  if (!hasGlob(pattern)) return insensitive ? candidate.toLowerCase() === pattern.toLowerCase() : candidate === pattern;
  return new RegExp(`^${globSource(pattern, false)}$`, flags).test(candidate);
}

function pathMatch(candidate: string, pattern: string): boolean {
  const actual = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
  const wanted = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!hasGlob(wanted)) return actual === wanted || (!wanted.startsWith('/') && actual.endsWith('/' + wanted));
  const prefix = wanted.startsWith('/') ? '^' : '(?:^|/)';
  return new RegExp(`${prefix}${globSource(wanted, true)}$`).test(actual);
}

function commandPrefixMatch(command: string, pattern: string): boolean {
  const actual = command.trimStart();
  if (hasGlob(pattern)) return new RegExp(`^${globSource(pattern, false)}`).test(actual);
  if (!actual.startsWith(pattern)) return false;
  const boundary = actual[pattern.length];
  return boundary === undefined || /\s/.test(boundary) || /[;&|]/.test(pattern[pattern.length - 1] ?? '');
}

function anyMatch(values: readonly string[], patterns: readonly string[], match: (value: string, pattern: string) => boolean): boolean {
  return patterns.some((pattern) => values.some((value) => match(value, pattern)));
}

/** Return every baseline entry matching the subject. No match mutates or removes
 * the subject; callers use the non-empty result only to add an `expected` label. */
export function matchBaseline(policy: BaselinePolicyV1, subject: BaselineSubject): BaselineMatch[] {
  const normalized = parseBaselinePolicy(policy);
  const matches: BaselineMatch[] = [];
  for (const entry of normalized.expected) {
    if (entry.finding_ids && !anyMatch([subject.finding_id], entry.finding_ids, scalarMatch)) continue;
    if (entry.rule_ids && !anyMatch(subject.rule_ids, entry.rule_ids, scalarMatch)) continue;
    if (entry.hosts && !anyMatch(subject.hosts, entry.hosts, (value, pattern) => scalarMatch(value, pattern, true))) continue;
    if (entry.paths && !anyMatch(subject.paths, entry.paths, pathMatch)) continue;
    if (entry.command_prefixes && !anyMatch(subject.commands, entry.command_prefixes, commandPrefixMatch)) continue;
    if (entry.mcp_servers && !anyMatch(subject.mcp_servers, entry.mcp_servers, (value, pattern) => scalarMatch(value, pattern, true))) continue;
    matches.push({ id: entry.id, reason: entry.reason });
  }
  return matches;
}
