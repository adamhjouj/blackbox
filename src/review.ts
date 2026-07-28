/**
 * Pure Review Inbox projection.
 *
 * This module only reads normalized/derived values supplied by its caller. It
 * does not write the event store, and acknowledgements/baselines never suppress
 * or alter immutable evidence. Session-level causal findings and independently
 * risky actions remain distinct review items.
 */
import { matchBaseline, baselinePolicyHash, type BaselineMatch, type BaselinePolicyV1, type LoadedBaselinePolicy } from './baseline';
import { actionOutcome, projectFindings, type FindingOutcome } from './findings';
import { canonical, hashString } from './hash';
import { commandReadsSensitiveFile, RISK_FLAGS, type FlagId } from './risk-rules';
import type { ComboFire } from './risk-engine';
import type { BlackboxEvent } from './types';

export type ReviewFindingKind = 'combo' | 'action';
export type ReviewSeverity = 'high' | 'medium' | 'low';
export type ReviewDisposition = 'unreviewed' | 'acknowledged' | 'expected' | 'false_positive';

export interface FindingKeyMaterial {
  session_id: string;
  ruleset_version: string;
  kind: ReviewFindingKind;
  id: string;
  related_seqs: readonly number[];
}

/** A risk row after its JSON `flags`/`evidence` columns have been parsed. */
export interface ReviewRiskInput {
  seq: number;
  score: number;
  flags: readonly string[];
  evidence?: Record<string, unknown> | null;
}

export interface ReviewFinding {
  key: string;
  session_id: string;
  ruleset_version: string;
  kind: ReviewFindingKind;
  /** Stable category id (`exfil-chain`, `action-risk`, ...), not a row id. */
  id: string;
  title: string;
  note: string;
  severity: ReviewSeverity;
  score: number;
  outcome: FindingOutcome;
  related_seqs: number[];
  rule_ids: string[];
  target: string | null;
  hosts: string[];
  paths: string[];
  commands: string[];
  mcp_servers: string[];
  /** Baselines annotate only. A finding stays in the returned array. */
  expected: boolean;
  baseline_matches: BaselineMatch[];
  policy_hash: string | null;
}

export interface ReviewProjectionInput {
  session_id: string;
  ruleset_version: string;
  events: readonly BlackboxEvent[];
  combos: readonly ComboFire[];
  risks: readonly ReviewRiskInput[];
  baseline?: LoadedBaselinePolicy | BaselinePolicyV1 | null;
}

function normalizedSeqs(seqs: readonly number[]): number[] {
  return [...new Set(seqs.filter((seq) => Number.isSafeInteger(seq) && seq > 0))].sort((a, b) => a - b);
}

/** Stable across input ordering and duplicate evidence references. The digest is
 * intentionally limited to the canonical session/ruleset/kind/id/seq tuple. */
export function findingKey(material: FindingKeyMaterial): string {
  if (!material.session_id || !material.ruleset_version || !material.kind || !material.id) {
    throw new Error('finding key fields must be non-empty');
  }
  const related_seqs = normalizedSeqs(material.related_seqs);
  if (!related_seqs.length) throw new Error('finding key requires at least one related seq');
  const bytes = canonical({
    session_id: material.session_id,
    ruleset_version: material.ruleset_version,
    kind: material.kind,
    id: material.id,
    related_seqs,
  });
  return hashString(`blackbox-review-finding-v1\n${bytes}`);
}

interface Entities {
  hosts: Set<string>;
  paths: Set<string>;
  commands: Set<string>;
  mcpServers: Set<string>;
}

function newEntities(): Entities {
  return { hosts: new Set(), paths: new Set(), commands: new Set(), mcpServers: new Set() };
}

function addPath(entities: Entities, candidate: unknown): void {
  if (typeof candidate !== 'string' || !candidate.trim()) return;
  const value = candidate.trim();
  const fromCommand = commandReadsSensitiveFile(value);
  if (fromCommand) entities.paths.add(fromCommand);
  else if (!/\s/.test(value)) entities.paths.add(value);
}

function addUrlHost(entities: Entities, candidate: string): void {
  for (const match of candidate.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    try {
      entities.hosts.add(new URL(match[0]!.replace(/[),.;]+$/, '')).hostname);
    } catch {
      // A malformed/truncated URL remains visible in the event target; it simply
      // cannot participate in a host baseline.
    }
  }
}

function addEventEntities(entities: Entities, event: BlackboxEvent): void {
  const target = event.target?.trim();
  if (target) {
    addUrlHost(entities, target);
    if (event.action_type === 'shell_command' || event.action_type === 'git_action') {
      entities.commands.add(target);
      addPath(entities, commandReadsSensitiveFile(target));
    } else if (event.action_type === 'file_read' || event.action_type === 'file_write' || event.action_type === 'file_edit') {
      addPath(entities, target);
    }
  }
  if (event.action_type === 'mcp_call' && event.tool_name?.startsWith('mcp__')) {
    const server = event.tool_name.split('__')[1];
    if (server) entities.mcpServers.add(server);
  }
}

function addEvidenceEntities(entities: Entities, evidence: Record<string, unknown> | null | undefined): void {
  if (!evidence) return;
  for (const value of Object.values(evidence)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.host === 'string' && item.host.trim()) entities.hosts.add(item.host.trim());
    if (typeof item.server === 'string' && item.server.trim()) entities.mcpServers.add(item.server.trim());
    addPath(entities, item.path);
    addPath(entities, item.secret);
  }
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function baselineParts(baseline: ReviewProjectionInput['baseline']): { policy: BaselinePolicyV1; hash: string } | null {
  if (!baseline) return null;
  if ('policy' in baseline) return { policy: baseline.policy, hash: baseline.hash };
  return { policy: baseline, hash: baselinePolicyHash(baseline) };
}

/** Add expected/baseline labels while preserving the number, identity, and order
 * of findings. This explicit transform makes accidental suppression testable. */
export function applyFindingBaselines(
  findings: readonly ReviewFinding[],
  baseline: LoadedBaselinePolicy | BaselinePolicyV1 | null | undefined,
): ReviewFinding[] {
  const loaded = baselineParts(baseline);
  return findings.map((finding) => {
    const matches = loaded
      ? matchBaseline(loaded.policy, {
          finding_id: finding.id,
          rule_ids: finding.rule_ids,
          hosts: finding.hosts,
          paths: finding.paths,
          commands: finding.commands,
          mcp_servers: finding.mcp_servers,
        })
      : [];
    return {
      ...finding,
      expected: matches.length > 0,
      baseline_matches: matches,
      policy_hash: loaded?.hash ?? null,
    };
  });
}

function comboFindings(input: ReviewProjectionInput): ReviewFinding[] {
  const events = [...input.events];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return projectFindings(events, [...input.combos]).map((combo) => {
    const related = normalizedSeqs(combo.related_seqs);
    const entities = newEntities();
    if (combo.host) entities.hosts.add(combo.host);
    for (const seq of related) {
      const event = bySeq.get(seq);
      if (event) addEventEntities(entities, event);
    }
    const target = bySeq.get(combo.consequent_seq)?.target ?? null;
    return {
      key: findingKey({
        session_id: input.session_id,
        ruleset_version: input.ruleset_version,
        kind: 'combo',
        id: combo.id,
        related_seqs: related,
      }),
      session_id: input.session_id,
      ruleset_version: input.ruleset_version,
      kind: 'combo',
      id: combo.id,
      title: titleCase(combo.id),
      note: combo.display_note,
      severity: combo.severity,
      score: combo.severity === 'high' ? 80 : 50,
      outcome: combo.outcome,
      related_seqs: related,
      rule_ids: [],
      target,
      hosts: sorted(entities.hosts),
      paths: sorted(entities.paths),
      commands: sorted(entities.commands),
      mcp_servers: sorted(entities.mcpServers),
      expected: false,
      baseline_matches: [],
      policy_hash: null,
    };
  });
}

interface ActionGroup {
  events: BlackboxEvent[];
  risks: ReviewRiskInput[];
}

function actionGroupKey(event: BlackboxEvent | undefined, seq: number): string {
  return event?.tool_use_id ? `tool:${event.tool_use_id}` : `seq:${seq}`;
}

function severityForScore(score: number): ReviewSeverity {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

function actionFindings(input: ReviewProjectionInput): ReviewFinding[] {
  const events = [...input.events];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const groups = new Map<string, ActionGroup>();

  // Seed complete tool-use groups first. A risk on Pre and Post will then join
  // one action even when hook delivery/order is unusual.
  for (const event of events) {
    const key = actionGroupKey(event, event.seq);
    const group = groups.get(key) ?? { events: [], risks: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  for (const risk of input.risks) {
    const event = bySeq.get(risk.seq);
    const key = actionGroupKey(event, risk.seq);
    const group = groups.get(key) ?? { events: event ? [event] : [], risks: [] };
    group.risks.push(risk);
    groups.set(key, group);
  }

  const findings: ReviewFinding[] = [];
  for (const group of groups.values()) {
    const rules = new Set<string>();
    const relevantRisks: ReviewRiskInput[] = [];
    for (const risk of group.risks) {
      const riskFlags = risk.flags.filter((flag) => RISK_FLAGS.has(flag as FlagId));
      if (!riskFlags.length || risk.score <= 0) continue;
      for (const flag of riskFlags) rules.add(flag);
      relevantRisks.push(risk);
    }
    if (!rules.size) continue; // annotation-only actions belong to combos, not inbox noise

    group.events.sort((a, b) => a.seq - b.seq);
    const representative = group.events.find((event) => event.phase === 'pre') ?? group.events[0];
    const related = normalizedSeqs([
      ...group.events.map((event) => event.seq),
      ...relevantRisks.map((risk) => risk.seq),
    ]);
    if (!related.length) continue;
    const score = Math.max(...relevantRisks.map((risk) => risk.score));
    const ruleIds = [...rules].sort();
    const entities = newEntities();
    for (const event of group.events) addEventEntities(entities, event);
    for (const risk of group.risks) addEvidenceEntities(entities, risk.evidence);

    const outcome: FindingOutcome = representative ? actionOutcome(events, representative) : 'unknown';
    const title = ruleIds.length === 1 ? titleCase(ruleIds[0]!) : 'Flagged action';
    const target = representative?.target ?? group.events.find((event) => event.target)?.target ?? null;
    const earliest = related[0]!;
    findings.push({
      key: findingKey({
        session_id: input.session_id,
        ruleset_version: input.ruleset_version,
        kind: 'action',
        id: 'action-risk',
        related_seqs: related,
      }),
      session_id: input.session_id,
      ruleset_version: input.ruleset_version,
      kind: 'action',
      id: 'action-risk',
      title,
      note: `Action ${earliest} matched ${ruleIds.join(', ')}`,
      severity: severityForScore(score),
      score,
      outcome,
      related_seqs: related,
      rule_ids: ruleIds,
      target,
      hosts: sorted(entities.hosts),
      paths: sorted(entities.paths),
      commands: sorted(entities.commands),
      mcp_servers: sorted(entities.mcpServers),
      expected: false,
      baseline_matches: [],
      policy_hash: null,
    });
  }
  return findings;
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Project the reviewable set. Per-event annotations never create standalone
 * action findings; they remain available as evidence for a causal combo. */
export function deriveReviewFindings(input: ReviewProjectionInput): ReviewFinding[] {
  const deduped = new Map<string, ReviewFinding>();
  for (const finding of [...comboFindings(input), ...actionFindings(input)]) {
    if (!deduped.has(finding.key)) deduped.set(finding.key, finding);
  }
  const findings = [...deduped.values()].sort((a, b) => {
    return (
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.related_seqs[0] ?? 0) - (b.related_seqs[0] ?? 0) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id)
    );
  });
  return applyFindingBaselines(findings, input.baseline);
}

export interface ReviewCheckpoint {
  reviewed_through_seq: number;
  reviewed_through_hash: string;
  policy_hash: string | null;
}

/** A review is stale when either the evidence head or the policy used to review
 * it changed. This is pure so storage/UI layers can share one rule. */
export function reviewIsStale(
  review: ReviewCheckpoint,
  current: { last_seq: number; last_hash: string; policy_hash: string | null },
): boolean {
  return (
    review.reviewed_through_seq !== current.last_seq ||
    review.reviewed_through_hash !== current.last_hash ||
    review.policy_hash !== current.policy_hash
  );
}
