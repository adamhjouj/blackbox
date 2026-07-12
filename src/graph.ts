/**
 * R4 — the provenance graph. A PURE, read-time projection of the session story +
 * risk combos into a node-link graph (the "Obsidian" view). No capture, no schema,
 * nothing hashed — `verify()` is untouched. What a linear timeline hides, a graph
 * shows: fan-out, shared-entity relationships (a file touched by many steps), and a
 * fired exfil chain drawn as a red path.
 *
 * Two resolutions, so the whole-session view stays readable while a single turn is
 * fully detailed:
 *  - session overview: prompt · file · commit · risk nodes (steps are aggregated).
 *  - single turn (`promptId`): prompt · every step · files · commits · risk.
 */
import type { SessionStory } from './provenance';
import type { ComboEvidence } from './read-api';
import { RISK_FLAGS, type FlagId } from './risk-rules';

export type NodeType = 'prompt' | 'step' | 'file' | 'commit' | 'host' | 'secret' | 'mcp';
export type EdgeType = 'caused' | 'changed' | 'committed' | 'spawned' | 'read' | 'sent' | 'combo';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  /** The event seq to drill into (null for aggregate/entity nodes). */
  seq: number | null;
  risk: boolean;
  degree: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  risk: boolean;
}
export interface SessionGraph {
  session_id: string;
  detailed: boolean; // a single-turn subgraph (steps shown) vs a session overview
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: { nodes: number; edges: number };
}

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;
const isRiskySignal = (sigs: FlagId[] | undefined): boolean => !!sigs && sigs.some((s) => RISK_FLAGS.has(s));

export function buildGraph(story: SessionStory, combos: ComboEvidence[], promptId?: string | null): SessionGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const detailed = !!promptId;

  const addNode = (id: string, type: NodeType, label: string, seq: number | null, risk = false): void => {
    const cur = nodes.get(id);
    if (cur) {
      if (risk) cur.risk = true;
      return;
    }
    nodes.set(id, { id, type, label, seq, risk, degree: 0 });
  };
  const addEdge = (from: string, to: string, type: EdgeType, risk = false): void => {
    if (from !== to && nodes.has(from) && nodes.has(to)) edges.push({ from, to, type, risk });
  };

  // seq → the prompt node that owns it, so a risk combo can attach to the graph even
  // in the overview (where individual steps aren't nodes).
  const seqToPrompt = new Map<number, string>();

  const turns = promptId ? story.turns.filter((t) => t.prompt_id === promptId) : story.turns;
  turns.forEach((t, ti) => {
    const pid = 'p:' + (t.prompt_id || '#' + ti);
    const plabel = t.prompt ? t.prompt.replace(/\s+/g, ' ').slice(0, 60) : 'turn ' + (ti + 1);
    addNode(pid, 'prompt', plabel, t.steps[0]?.seq ?? null);

    if (detailed) {
      let lastTask: string | null = null;
      for (const s of t.steps) {
        const sid = 's:' + s.seq;
        addNode(sid, 'step', (s.summary || s.tool || s.type || 'step').slice(0, 40), s.post_seq ?? s.seq, isRiskySignal(s.signals));
        if (s.is_subagent && lastTask) addEdge(lastTask, sid, 'spawned');
        else addEdge(pid, sid, 'caused');
        if (s.type === 'task_control') lastTask = sid;
        seqToPrompt.set(s.seq, pid);
        if (s.post_seq != null) seqToPrompt.set(s.post_seq, pid);
        for (const f of s.files) {
          const fid = 'f:' + f.path;
          addNode(fid, 'file', basename(f.path), f.seq);
          addEdge(sid, fid, 'changed');
        }
      }
    } else {
      for (const s of t.steps) {
        seqToPrompt.set(s.seq, pid);
        if (s.post_seq != null) seqToPrompt.set(s.post_seq, pid);
      }
      // overview: connect the prompt straight to the files it changed
      for (const f of t.files_changed) {
        const fid = 'f:' + f.path;
        addNode(fid, 'file', basename(f.path), f.seq);
        addEdge(pid, fid, 'changed');
      }
    }
    for (const c of t.commits) {
      const cid = 'c:' + c.seq;
      addNode(cid, 'commit', ((c.sha ?? '').slice(0, 7) + ' ' + (c.subject ?? '')).trim() || 'commit', c.seq);
      addEdge(pid, cid, 'committed');
    }
  });

  // risk combos → secret / host / mcp entities + the red exfil path. Anchor to the
  // step node when it exists (detailed), else to the prompt that owns the seq (overview).
  const anchorFor = (seq: number): string | null => (nodes.has('s:' + seq) ? 's:' + seq : seqToPrompt.get(seq) ?? null);
  const markRisk = (id: string | null): void => {
    if (id && nodes.has(id)) nodes.get(id)!.risk = true;
  };
  for (const cb of combos) {
    if (cb.id === 'exfil-chain' || cb.id.startsWith('injected')) {
      const sec = 'sec:' + cb.antecedent_seq;
      addNode(sec, 'secret', 'secret', cb.antecedent_seq, true);
      const ant = anchorFor(cb.antecedent_seq);
      const con = anchorFor(cb.consequent_seq);
      markRisk(ant);
      markRisk(con);
      if (ant) addEdge(ant, sec, 'read', true);
      if (cb.host) {
        const h = 'host:' + cb.host;
        addNode(h, 'host', cb.host, null, true);
        if (con) addEdge(con, h, 'sent', true);
        addEdge(sec, h, 'combo', true); // the drawn red path
      } else if (con) {
        addEdge(sec, con, 'combo', true); // exfil path without a resolved host node
      }
    }
    if (cb.server) addNode('mcp:' + cb.server, 'mcp', cb.server, null, true);
  }

  for (const e of edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (a) a.degree++;
    if (b) b.degree++;
  }
  const arr = [...nodes.values()];
  return { session_id: story.session_id, detailed, nodes: arr, edges, counts: { nodes: arr.length, edges: edges.length } };
}
