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
 *
 * Every node also carries two lightweight layout hints, `rank` (its role in the
 * causal flow) and `turn` (the turn it first appears in). These drive the hybrid
 * force layout in the UI — prompts drift up, outcomes down, earlier turns left — so
 * a busy session settles into a readable shape instead of a hairball. They are pure
 * interpretation (derived from the story), never captured, never hashed.
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
  /** Role in the causal flow: 0 prompt · 1 step · 2 file/entity · 3 commit. Drives the vertical (flow) bias. */
  rank: number;
  /** The turn index this node first appears in. Drives the horizontal (time) bias. */
  turn: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  risk: boolean;
  /** How many times this exact relationship occurs — parallel edges are merged, not duplicated. */
  weight: number;
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

// Role → vertical rank. Entities (file/host/secret/mcp) all sit on the "outcome" band.
const RANK: Record<NodeType, number> = { prompt: 0, step: 1, file: 2, host: 2, secret: 2, mcp: 2, commit: 3 };

export function buildGraph(story: SessionStory, combos: ComboEvidence[], promptId?: string | null): SessionGraph {
  const nodes = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  const detailed = !!promptId;

  const addNode = (id: string, type: NodeType, label: string, seq: number | null, risk = false, turn = 0): void => {
    const cur = nodes.get(id);
    if (cur) {
      if (risk) cur.risk = true;
      if (turn < cur.turn) cur.turn = turn; // a shared entity anchors to its earliest turn
      return;
    }
    nodes.set(id, { id, type, label, seq, risk, degree: 0, rank: RANK[type], turn });
  };
  const addEdge = (from: string, to: string, type: EdgeType, risk = false): void => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const k = JSON.stringify([from, to, type]);
    const cur = edgeMap.get(k);
    if (cur) {
      cur.weight++;
      if (risk) cur.risk = true;
      return;
    }
    edgeMap.set(k, { from, to, type, risk, weight: 1 });
  };

  // seq → the node a risk combo should attach to. A step's seq AND its post_seq both
  // map to the step node (combos often cite the POST/output seq, e.g. a redaction-
  // detected secret-touch), preferred over the owning prompt.
  const seqToPrompt = new Map<number, string>();
  const seqToStep = new Map<number, string>();

  const turns = promptId ? story.turns.filter((t) => t.prompt_id === promptId) : story.turns;
  turns.forEach((t, ti) => {
    const pid = 'p:' + (t.prompt_id || '#' + ti);
    const plabel = t.prompt ? t.prompt.replace(/\s+/g, ' ').slice(0, 60) : 'turn ' + (ti + 1);
    addNode(pid, 'prompt', plabel, t.steps[0]?.seq ?? null, false, ti);

    if (detailed) {
      let lastTask: string | null = null;
      for (const s of t.steps) {
        const sid = 's:' + s.seq;
        addNode(sid, 'step', (s.summary || s.tool || s.type || 'step').slice(0, 40), s.post_seq ?? s.seq, isRiskySignal(s.signals), ti);
        if (s.is_subagent && lastTask) addEdge(lastTask, sid, 'spawned');
        else addEdge(pid, sid, 'caused');
        if (s.type === 'task_control') lastTask = sid;
        seqToPrompt.set(s.seq, pid);
        seqToStep.set(s.seq, sid);
        if (s.post_seq != null) {
          seqToPrompt.set(s.post_seq, pid);
          seqToStep.set(s.post_seq, sid);
        }
        for (const f of s.files) {
          const fid = 'f:' + f.path;
          addNode(fid, 'file', basename(f.path), f.seq, false, ti);
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
        addNode(fid, 'file', basename(f.path), f.seq, false, ti);
        addEdge(pid, fid, 'changed');
      }
    }
    for (const c of t.commits) {
      const cid = 'c:' + c.seq;
      addNode(cid, 'commit', ((c.sha ?? '').slice(0, 7) + ' ' + (c.subject ?? '')).trim() || 'commit', c.seq, false, ti);
      addEdge(pid, cid, 'committed');
    }
  });

  // risk combos → secret / host / mcp entities + the red exfil path. Anchor to the
  // step node (via seqToStep, incl. post_seq) when present, else the owning prompt.
  const anchorFor = (seq: number): string | null => seqToStep.get(seq) ?? seqToPrompt.get(seq) ?? null;
  const turnOf = (id: string | null): number => {
    const n = id ? nodes.get(id) : undefined;
    return n ? n.turn : 0;
  };
  const markRisk = (id: string | null): void => {
    if (id && nodes.has(id)) nodes.get(id)!.risk = true;
  };
  for (const cb of combos) {
    const ant = anchorFor(cb.antecedent_seq);
    const con = anchorFor(cb.consequent_seq);
    // A combo that anchors nowhere in this (sub)graph belongs to a different turn —
    // never draw a fabricated exfil path on an unrelated turn.
    if (!ant && !con) continue;
    if (cb.id === 'exfil-chain' || cb.id.startsWith('injected')) {
      const sec = 'sec:' + cb.antecedent_seq;
      addNode(sec, 'secret', 'secret', cb.antecedent_seq, true, turnOf(ant ?? con));
      markRisk(ant);
      markRisk(con);
      if (ant) addEdge(ant, sec, 'read', true);
      if (cb.host) {
        const h = 'host:' + cb.host;
        addNode(h, 'host', cb.host, null, true, turnOf(con ?? ant));
        if (con) addEdge(con, h, 'sent', true);
        addEdge(sec, h, 'combo', true); // the drawn red path
      } else if (con) {
        addEdge(sec, con, 'combo', true); // exfil path without a resolved host node
      }
    }
    if (cb.server) {
      const m = 'mcp:' + cb.server;
      addNode(m, 'mcp', cb.server, null, true, turnOf(con ?? ant));
      const a = con || ant; // link the poisoned server to the step/prompt that used it
      if (a) addEdge(a, m, 'read', true);
    }
  }

  const edges = [...edgeMap.values()];
  for (const e of edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (a) a.degree++;
    if (b) b.degree++;
  }
  const arr = [...nodes.values()];
  return { session_id: story.session_id, detailed, nodes: arr, edges, counts: { nodes: arr.length, edges: edges.length } };
}
