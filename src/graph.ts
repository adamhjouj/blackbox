/**
 * R4 — the provenance TREE. A PURE, read-time projection of the session story into
 * a rooted tree: a prompt and the things it produced (files changed · commits ·
 * subagents · risk) branch beneath it. No capture, no schema, nothing hashed —
 * `verify()` is untouched.
 *
 * This replaces the earlier force-directed "Obsidian" graph, which was unreadable:
 * a session is mostly disconnected prompts, so a physics layout had nothing to
 * organise. A tree answers the actual question — *what did this prompt create?* —
 * deterministically and legibly.
 *
 * Two resolutions:
 *  - session overview: a `session` root → one `prompt` node per turn (its outcomes
 *    collapsed by the UI until you open a turn).
 *  - single turn (`promptId`): that turn's `prompt` is the root, fully expanded.
 */
import type { SessionStory, Turn, FileChange } from './provenance';
import type { ComboEvidence } from './read-api';

export type TreeType = 'session' | 'prompt' | 'file' | 'commit' | 'subagent' | 'secret' | 'host' | 'mcp';

export interface TreeNode {
  id: string;
  type: TreeType;
  label: string;
  sub: string | null; // a small subtitle (churn, counts, a tool name)
  seq: number | null; // the event seq to drill into (null for aggregate/entity nodes)
  risk: boolean;
  children: TreeNode[];
}
export interface SessionTree {
  session_id: string;
  detailed: boolean; // a single-turn tree vs the session overview
  root: TreeNode;
  counts: { nodes: number };
}

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;
const churn = (f: FileChange): string | null => {
  const parts: string[] = [];
  if (f.insertions) parts.push('+' + f.insertions);
  if (f.deletions) parts.push('-' + f.deletions);
  return parts.length ? parts.join(' ') : (f.status === 'skipped' ? 'skipped' : null);
};
const countNodes = (n: TreeNode): number => 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
const hasContent = (t: Turn): boolean => !!t.prompt || t.steps.length > 0 || t.files_changed.length > 0 || t.commits.length > 0;

export function buildTree(story: SessionStory, combos: ComboEvidence[], promptId?: string | null): SessionTree {
  // Map every step seq (and its post_seq) to the turn it belongs to, so a fired risk
  // combo can be attached to the exact turn that produced it (never a different one).
  const seqTurn = new Map<number, number>();
  story.turns.forEach((t, ti) => {
    for (const s of t.steps) {
      seqTurn.set(s.seq, ti);
      if (s.post_seq != null) seqTurn.set(s.post_seq, ti);
    }
  });
  const riskByTurn = new Map<number, TreeNode[]>();
  const pushRisk = (ti: number, node: TreeNode): void => {
    const arr = riskByTurn.get(ti) ?? [];
    arr.push(node);
    riskByTurn.set(ti, arr);
  };
  for (const cb of combos) {
    const ti = seqTurn.get(cb.antecedent_seq) ?? seqTurn.get(cb.consequent_seq);
    if (ti == null) continue; // the combo belongs to no visible turn — never fabricate it
    if (cb.id === 'exfil-chain' || cb.id.startsWith('injected')) {
      const host: TreeNode[] = cb.host
        ? [{ id: 'host:' + ti + ':' + cb.host, type: 'host', label: cb.host, sub: 'exfil target', seq: null, risk: true, children: [] }]
        : [];
      pushRisk(ti, { id: 'sec:' + cb.antecedent_seq, type: 'secret', label: 'secret touched', sub: 'exfil chain', seq: cb.antecedent_seq, risk: true, children: host });
    }
    if (cb.server) {
      pushRisk(ti, { id: 'mcp:' + ti + ':' + cb.server, type: 'mcp', label: cb.server, sub: 'tool poisoning', seq: null, risk: true, children: [] });
    }
  }

  const turnNode = (t: Turn, ti: number): TreeNode => {
    const children: TreeNode[] = [];
    for (const f of t.files_changed) {
      children.push({ id: 'f:' + ti + ':' + f.path, type: 'file', label: basename(f.path), sub: churn(f), seq: f.seq, risk: false, children: [] });
    }
    for (const c of t.commits) {
      const label = ((c.sha ?? '').slice(0, 7) + ' ' + (c.subject ?? '')).trim() || 'commit';
      children.push({ id: 'c:' + c.seq, type: 'commit', label, sub: c.files ? c.files + ' files' : 'commit', seq: c.seq, risk: false, children: [] });
    }
    // subagents delegated within the turn (distinct agent types), most-recent seq kept
    const subs = new Map<string, { count: number; seq: number }>();
    for (const s of t.steps) {
      if (s.is_subagent && s.agent_type) {
        const cur = subs.get(s.agent_type);
        if (cur) cur.count++;
        else subs.set(s.agent_type, { count: 1, seq: s.seq });
      }
    }
    for (const [name, info] of subs) {
      children.push({ id: 'sub:' + ti + ':' + name, type: 'subagent', label: name, sub: info.count + ' step' + (info.count === 1 ? '' : 's'), seq: info.seq, risk: false, children: [] });
    }
    for (const rn of riskByTurn.get(ti) ?? []) children.push(rn);

    const parts: string[] = [];
    if (t.steps.length) parts.push(t.steps.length + ' step' + (t.steps.length === 1 ? '' : 's'));
    if (t.files_changed.length) parts.push(t.files_changed.length + ' file' + (t.files_changed.length === 1 ? '' : 's'));
    if (t.commits.length) parts.push(t.commits.length + ' commit' + (t.commits.length === 1 ? '' : 's'));
    return {
      id: 'p:' + (t.prompt_id || '#' + ti),
      type: 'prompt',
      label: t.prompt ? t.prompt.replace(/\s+/g, ' ') : 'turn ' + (ti + 1),
      sub: parts.join(' · ') || 'no changes',
      seq: t.steps[0]?.seq ?? null,
      risk: t.flagged > 0,
      children,
    };
  };

  let root: TreeNode;
  if (promptId) {
    const ti = story.turns.findIndex((t) => t.prompt_id === promptId);
    root = ti >= 0 ? turnNode(story.turns[ti]!, ti) : { id: 'empty', type: 'session', label: story.name ?? 'session', sub: 'turn not found', seq: null, risk: false, children: [] };
  } else {
    const turnNodes = story.turns.map((t, ti) => (hasContent(t) ? turnNode(t, ti) : null)).filter((n): n is TreeNode => !!n);
    const flagged = story.verdict !== 'none' && story.verdict !== 'unscored' && story.verdict !== '';
    root = {
      id: 'session:' + story.session_id,
      type: 'session',
      label: story.name ?? 'session',
      sub: turnNodes.length + ' turn' + (turnNodes.length === 1 ? '' : 's'),
      seq: null,
      risk: flagged,
      children: turnNodes,
    };
  }

  return { session_id: story.session_id, detailed: !!promptId, root, counts: { nodes: countNodes(root) } };
}
