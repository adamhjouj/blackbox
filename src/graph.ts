/**
 * R4 — the provenance TRACE. A PURE, read-time projection of the session story
 * (+ risk combos) into a causal DAG, laid out deterministically with a hand-rolled
 * Sugiyama (layered) algorithm. No capture, no schema, nothing hashed — `verify()`
 * is untouched by anything here.
 *
 * Why a layered DAG and not a force graph or a tree:
 *   Our data is a DAG with a time axis — prompt → step → file/commit → finding.
 *   A force layout discards the one thing that carries meaning (the direction of
 *   causality) and is NON-deterministic: the same session moves on every reload,
 *   which is disqualifying for a forensic tool. A layered layout flows causality
 *   along one axis (left→right) and, computed here on the server from a pure
 *   function, is byte-identical on every render.
 *
 * The default lens is a TRACE, not a whole-session dump: rooted at a finding (or a
 * chosen node), showing its causal ANCESTRY (what caused it) and DESCENDANTS (what
 * it caused) out to a small depth — a readable ~10-node chain, e.g.
 *   prompt → read ~/.ssh → [EXFIL] → send → evil.example.com
 * The whole session stays available (same layout, aggressive directory aggregation)
 * but is never the default.
 */
import type { SessionStory, Turn, FileChange } from './provenance';
import type { ComboEvidence } from './read-api';

export type DagKind = 'prompt' | 'step' | 'file' | 'dir' | 'commit' | 'finding' | 'host';
// Distinct relation types so the UI can style edges by meaning.
export type DagRel = 'caused' | 'wrote' | 'committed' | 'flagged' | 'sent';

export interface DagNode {
  id: string;
  kind: DagKind;
  label: string;
  sub: string | null;
  seq: number | null; // event seq to open the dossier (null for aggregate/entity nodes)
  risk: boolean;
  size: 'lg' | 'md' | 'sm'; // significance tier → node dimensions
  // layout (filled by layout(); 0 until positioned)
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}
export interface DagEdge {
  from: string;
  to: string;
  rel: DagRel;
  points: Array<{ x: number; y: number }>; // routed polyline centres (filled by layout)
}
export interface RootOption {
  id: string;
  label: string;
  risk: boolean;
  kind: DagKind;
}
export interface TraceView {
  session_id: string;
  detailed: boolean; // a rooted trace (true) vs the whole session (false)
  root: string | null; // the node the trace is rooted at
  depth: number; // hop radius (a large number means "all")
  roots: RootOption[]; // candidate roots for the UI selector (findings first, then turns)
  nodes: DagNode[]; // positioned
  edges: DagEdge[];
  width: number;
  height: number;
  counts: { nodes: number; edges: number };
}

export interface TraceOpts {
  root?: string | null;
  depth?: number | null; // hop radius; omit/<=0 → default; use ALL_DEPTH for "all"
  whole?: boolean; // render the whole session instead of a trace
  expand?: string[]; // ids of aggregate 'dir' nodes the user has expanded
}
export const ALL_DEPTH = 9999;

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;
const dirOf = (p: string): string => {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? parts[parts.length - 1]! + '/' : './';
};
const churn = (f: FileChange): string | null => {
  const parts: string[] = [];
  if (f.insertions) parts.push('+' + f.insertions);
  if (f.deletions) parts.push('-' + f.deletions);
  return parts.length ? parts.join(' ') : f.status === 'skipped' ? 'skipped' : null;
};
const hasContent = (t: Turn): boolean => !!t.prompt || t.steps.length > 0 || t.files_changed.length > 0 || t.commits.length > 0;
const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const AGG_MIN = 3; // a directory with ≥ this many non-risk files collapses into one expandable node

// ── the full causal model (unpositioned) ──────────────────────────────────────
interface Model {
  nodes: Map<string, DagNode>;
  edges: DagEdge[];
  dirFiles: Map<string, DagNode[]>; // a 'dir' node id → the individual file nodes it hides
  roots: RootOption[];
  defaultRoot: string | null;
}

function node(id: string, kind: DagKind, label: string, sub: string | null, seq: number | null, risk: boolean, size: 'lg' | 'md' | 'sm'): DagNode {
  return { id, kind, label, sub, seq, risk, size, x: 0, y: 0, w: 0, h: 0, layer: 0 };
}

/**
 * Build the whole session's causal DAG. Deterministic: turns in order, steps by
 * seq, files sorted by path, combos in array order — no clock, no randomness.
 *
 * Node set is deliberately sparse (this is what stops the hairball):
 *  - one `prompt` per turn that did something,
 *  - a `step` node only for steps that MATTER — a finding's antecedent/consequent,
 *    a risk-flagged step, or a subagent spawn; ordinary edits attach their file
 *    straight to the prompt (`prompt → file`),
 *  - `file`/`dir`/`commit` artifacts, `finding` + `host` for fired combos.
 */
function buildModel(story: SessionStory, combos: ComboEvidence[]): Model {
  const nodes = new Map<string, DagNode>();
  const edges: DagEdge[] = [];
  const dirFiles = new Map<string, DagNode[]>();
  const add = (n: DagNode): DagNode => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return nodes.get(n.id)!;
  };
  const link = (from: string, to: string, rel: DagRel): void => {
    if (from === to) return;
    edges.push({ from, to, rel, points: [] });
  };

  // Map each step seq (and its post_seq) to its turn index, so a combo is anchored
  // to the exact turn — and step — that produced it, never a different one.
  const seqTurn = new Map<number, number>();
  const seqStep = new Map<number, string>(); // step seq / post_seq → step node id (created lazily)
  story.turns.forEach((t, ti) => {
    for (const s of t.steps) {
      seqTurn.set(s.seq, ti);
      if (s.post_seq != null) seqTurn.set(s.post_seq, ti);
    }
  });

  // Which step seqs must become their own node (finding-linked, flagged, or a spawn).
  const actorSeq = new Set<number>();
  const findingConsequent = new Set<number>(); // consequent step seqs (hang off the finding, not the prompt)
  for (const cb of combos) {
    if (seqTurn.get(cb.antecedent_seq) == null && seqTurn.get(cb.consequent_seq) == null) continue;
    actorSeq.add(cb.antecedent_seq);
    actorSeq.add(cb.consequent_seq);
    findingConsequent.add(cb.consequent_seq);
  }

  const promptId = (t: Turn, ti: number): string => 'p:' + (t.prompt_id || '#' + ti);

  // Resolve a combo seq to a real step node in a turn (by the step's seq or post_seq).
  const stepIdForSeq = (ti: number, seq: number): string | null => {
    const t = story.turns[ti];
    if (!t) return null;
    for (const s of t.steps) if (s.seq === seq || s.post_seq === seq) return 's:' + s.seq;
    return null;
  };

  const roots: RootOption[] = [];

  story.turns.forEach((t, ti) => {
    if (!hasContent(t)) return;
    const pid = promptId(t, ti);
    const pLabel = t.prompt ? t.prompt.replace(/\s+/g, ' ') : 'turn ' + (ti + 1);
    const parts: string[] = [];
    if (t.steps.length) parts.push(t.steps.length + ' step' + (t.steps.length === 1 ? '' : 's'));
    if (t.files_changed.length) parts.push(t.files_changed.length + ' file' + (t.files_changed.length === 1 ? '' : 's'));
    if (t.commits.length) parts.push(t.commits.length + ' commit' + (t.commits.length === 1 ? '' : 's'));
    add(node(pid, 'prompt', pLabel, parts.join(' · ') || 'no changes', t.steps[0]?.seq ?? null, t.flagged > 0, 'lg'));
    roots.push({ id: pid, label: pLabel, risk: t.flagged > 0, kind: 'prompt' });

    // Actor-step nodes for this turn (finding-linked, risk-flagged, or a subagent spawn).
    for (const s of t.steps) {
      const isActor = actorSeq.has(s.seq) || (s.post_seq != null && actorSeq.has(s.post_seq)) || s.signals.length > 0 || (s.is_subagent && s.tool === 'Task');
      if (!isActor) continue;
      const sid = 's:' + s.seq;
      const label = (s.tool || s.type || 'step') + (s.target ? ' · ' + basename(s.target) : '');
      add(node(sid, 'step', label, s.summary ? s.summary.replace(/\s+/g, ' ').slice(0, 80) : null, s.post_seq || s.seq, s.signals.length > 0, 'md'));
      seqStep.set(s.seq, sid);
      if (s.post_seq != null) seqStep.set(s.post_seq, sid);
      // The prompt caused this step — unless the step is a finding's consequent, which
      // hangs off the finding instead (so the chain reads prompt→antecedent→[F]→consequent).
      if (!(actorSeq.has(s.seq) && findingConsequent.has(s.seq)) && !(s.post_seq != null && findingConsequent.has(s.post_seq))) {
        link(pid, sid, 'caused');
      }
    }

    // Files: attach to the producing step node if it's an actor, else straight to the prompt.
    const filesByParent = new Map<string, DagNode[]>();
    const sortedFiles = [...t.files_changed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const f of sortedFiles) {
      const parent = seqStep.get(f.seq) ?? pid;
      const fid = 'f:' + parent + ':' + f.path;
      const fn = node(fid, 'file', basename(f.path), churn(f), f.seq, false, 'sm');
      const arr = filesByParent.get(parent) ?? [];
      arr.push(fn);
      filesByParent.set(parent, arr);
    }
    // Aggregate a parent's files by directory: a group of ≥2 non-risk files collapses
    // into one expandable `dir` node. A risk file is never aggregated.
    for (const [parent, files] of filesByParent) {
      const groups = new Map<string, DagNode[]>();
      for (const f of files) {
        const path = f.id.slice(('f:' + parent + ':').length);
        const key = f.risk ? '@' + f.id : dirOf(path);
        const arr = groups.get(key) ?? [];
        arr.push(f);
        groups.set(key, arr);
      }
      for (const [key, group] of groups) {
        if (group.length >= AGG_MIN && !key.startsWith('@')) {
          const did = 'd:' + parent + ':' + key;
          const dn = node(did, 'dir', group.length + ' files in ' + key, null, null, false, 'md');
          add(dn);
          dirFiles.set(did, group);
          link(parent, did, 'wrote');
        } else {
          for (const f of group) {
            add(f);
            link(parent, f.id, 'wrote');
          }
        }
      }
    }

    // Commits: attach to the latest actor step that precedes the commit, else the prompt.
    for (const c of t.commits) {
      const cid = 'c:' + c.seq;
      const cl = ((c.sha ?? '').slice(0, 7) + ' ' + (c.subject ?? '')).trim() || 'commit';
      add(node(cid, 'commit', cl, c.files ? c.files + ' files' : 'commit', c.seq, false, 'md'));
      let producer = pid;
      let best = -1;
      for (const s of t.steps) {
        const sid = seqStep.get(s.seq);
        if (sid && s.seq < c.seq && s.seq > best) {
          best = s.seq;
          producer = sid;
        }
      }
      link(producer, cid, 'committed');
    }
  });

  // Findings (fired combos) — anchored exactly, never fabricated. The finding sits
  // causally between its antecedent (cause) and consequent (effect):
  //   antecedent --flagged--> finding --flagged--> consequent
  combos.forEach((cb, ci) => {
    const tiA = seqTurn.get(cb.antecedent_seq);
    const tiC = seqTurn.get(cb.consequent_seq);
    const ti = tiA ?? tiC;
    if (ti == null) return; // belongs to no visible turn — never fabricate it
    const fid = 'F:' + ci;
    const sev = cb.severity || 'high';
    const label = cb.id === 'exfil-chain' ? 'exfil chain' : cb.id.startsWith('injected') ? 'injected instruction' : cb.server ? 'tool poisoning' : cb.id.replace(/-/g, ' ');
    add(node(fid, 'finding', label, cb.note ? cb.note.replace(/\s+/g, ' ').slice(0, 90) : sev, cb.consequent_seq, true, 'lg'));
    roots.unshift({ id: fid, label: label + ' · ' + sev, risk: true, kind: 'finding' });

    const aStep = tiA != null ? stepIdForSeq(tiA, cb.antecedent_seq) : null;
    const cStep = tiC != null ? stepIdForSeq(tiC, cb.consequent_seq) : null;
    if (aStep && nodes.has(aStep)) link(aStep, fid, 'flagged');
    else link('p:' + (story.turns[ti]!.prompt_id || '#' + ti), fid, 'flagged');
    if (cStep && nodes.has(cStep)) {
      link(fid, cStep, 'flagged');
      if (cb.host) {
        const hid = 'h:' + ci;
        add(node(hid, 'host', cb.host, 'exfil target', null, true, 'md'));
        link(cStep, hid, 'sent');
      }
    } else if (cb.host) {
      const hid = 'h:' + ci;
      add(node(hid, 'host', cb.host, 'exfil target', null, true, 'md'));
      link(fid, hid, 'sent');
    }
    if (cb.server) {
      const mid = 'm:' + ci;
      add(node(mid, 'host', cb.server, 'poisoned server', null, true, 'md'));
      link(fid, mid, 'sent');
    }
  });

  // Findings first in the root list (already unshifted, but keep them sorted by severity).
  const findingRoots = roots.filter((r) => r.kind === 'finding').sort((a, b) => (SEV_RANK[a.label.split(' · ').pop()!] ?? 3) - (SEV_RANK[b.label.split(' · ').pop()!] ?? 3));
  const turnRoots = roots.filter((r) => r.kind === 'prompt');
  const orderedRoots = [...findingRoots, ...turnRoots];

  // Default root: highest-severity finding, else the turn with the most outcomes, else the first turn.
  let defaultRoot: string | null = findingRoots[0]?.id ?? null;
  if (!defaultRoot) {
    let bestScore = -1;
    for (const t of story.turns) {
      if (!hasContent(t)) continue;
      const ti = story.turns.indexOf(t);
      const score = t.files_changed.length + t.commits.length * 2 + t.flagged * 3;
      if (score > bestScore) {
        bestScore = score;
        defaultRoot = 'p:' + (t.prompt_id || '#' + ti);
      }
    }
  }

  return { nodes, edges, dirFiles, roots: orderedRoots, defaultRoot };
}

// ── trace extraction ──────────────────────────────────────────────────────────
/** The sub-DAG within `depth` causal hops (ancestry + descendants) of `root`. */
function subgraph(model: Model, root: string, depth: number): Set<string> {
  const outAdj = new Map<string, string[]>();
  const inAdj = new Map<string, string[]>();
  for (const e of model.edges) {
    if (!model.nodes.has(e.from) || !model.nodes.has(e.to)) continue;
    (outAdj.get(e.from) ?? outAdj.set(e.from, []).get(e.from)!).push(e.to);
    (inAdj.get(e.to) ?? inAdj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const keep = new Set<string>([root]);
  const walk = (adj: Map<string, string[]>): void => {
    let frontier = [root];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (!keep.has(nb)) {
            keep.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
  };
  walk(inAdj); // ancestry — what caused the root
  walk(outAdj); // descendants — what the root caused
  return keep;
}

/** Materialize expanded `dir` nodes into their individual file nodes (in `keep`). */
function applyExpand(model: Model, keep: Set<string>, expand: Set<string>): { nodes: DagNode[]; edges: DagEdge[] } {
  const localNodes = new Map<string, DagNode>();
  for (const id of keep) {
    const n = model.nodes.get(id);
    if (n) localNodes.set(id, { ...n });
  }
  const localEdges: DagEdge[] = [];
  for (const e of model.edges) {
    if (keep.has(e.from) && keep.has(e.to)) localEdges.push({ from: e.from, to: e.to, rel: e.rel, points: [] });
  }
  // Expand each requested dir node that is present.
  for (const did of expand) {
    if (!localNodes.has(did)) continue;
    const files = model.dirFiles.get(did);
    if (!files) continue;
    const parents = localEdges.filter((e) => e.to === did).map((e) => ({ from: e.from, rel: e.rel }));
    localNodes.delete(did);
    for (let i = localEdges.length - 1; i >= 0; i--) if (localEdges[i]!.to === did || localEdges[i]!.from === did) localEdges.splice(i, 1);
    for (const f of files) {
      localNodes.set(f.id, { ...f });
      for (const p of parents) localEdges.push({ from: p.from, to: f.id, rel: p.rel, points: [] });
    }
  }
  return { nodes: [...localNodes.values()], edges: localEdges };
}

// ── the Sugiyama layout (deterministic, server-side) ──────────────────────────
const DIMS: Record<'lg' | 'md' | 'sm', { w: number; h: number }> = {
  lg: { w: 248, h: 56 },
  md: { w: 208, h: 46 },
  sm: { w: 168, h: 40 },
};
const COL_GAP = 60; // horizontal gap between layers
const ROW_GAP = 26; // vertical gap between nodes in a layer
const PAD = 32;

interface LNode {
  id: string; // real node id, or 'dummy:N' for a routing point
  real: DagNode | null;
  layer: number;
  order: number;
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * Assign x/y to every node and route every edge — a layered (Sugiyama) layout:
 *   1. longest-path layering (deterministic; edges always point forward),
 *   2. dummy nodes so multi-layer edges route between adjacent columns only,
 *   3. barycenter crossing reduction (fixed sweeps, stable tiebreaks),
 *   4. a priority coordinate pass that pulls chains straight.
 * Left→right: layer → x column, order-in-layer → y. Pure — same input, same output.
 */
function layout(nodes: DagNode[], edges: DagEdge[]): { width: number; height: number } {
  if (!nodes.length) return { width: PAD * 2, height: PAD * 2 };
  for (const n of nodes) {
    const d = DIMS[n.size];
    n.w = d.w;
    n.h = d.h;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outE = new Map<string, string[]>();
  const inE = new Map<string, string[]>();
  for (const n of nodes) {
    outE.set(n.id, []);
    inE.set(n.id, []);
  }
  const realEdges = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  for (const e of realEdges) {
    outE.get(e.from)!.push(e.to);
    inE.get(e.to)!.push(e.from);
  }

  // 1. longest-path layering via a stable topological order (Kahn's).
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, inE.get(n.id)!.length);
  const order = [...nodes].map((n) => n.id).sort(); // stable seed order
  const queue = order.filter((id) => indeg.get(id) === 0);
  const layerOf = new Map<string, number>();
  for (const id of nodes.map((n) => n.id)) layerOf.set(id, 0);
  const topo: string[] = [];
  const q = [...queue];
  while (q.length) {
    const id = q.shift()!;
    topo.push(id);
    for (const to of outE.get(id)!) {
      layerOf.set(to, Math.max(layerOf.get(to)!, layerOf.get(id)! + 1));
      indeg.set(to, indeg.get(to)! - 1);
      if (indeg.get(to) === 0) {
        // insert keeping the queue sorted for determinism
        let i = 0;
        while (i < q.length && q[i]! < to) i++;
        q.splice(i, 0, to);
      }
    }
  }
  // Any node not reached (part of a cycle — shouldn't happen) keeps layer 0; guard anyway.

  // 2. build a layered node list with dummies for multi-layer edges.
  const layers: LNode[][] = [];
  const ensureLayer = (l: number): LNode[] => {
    while (layers.length <= l) layers.push([]);
    return layers[l]!;
  };
  const lnodes = new Map<string, LNode>();
  for (const n of nodes) {
    const l = layerOf.get(n.id)!;
    const ln: LNode = { id: n.id, real: n, layer: l, order: 0, w: n.w, h: n.h, x: 0, y: 0 };
    lnodes.set(n.id, ln);
    ensureLayer(l).push(ln);
  }
  let dummyCount = 0;
  interface LEdge {
    orig: DagEdge;
    chain: LNode[]; // from-node, dummies…, to-node
  }
  const ledges: LEdge[] = [];
  for (const e of realEdges) {
    const a = lnodes.get(e.from)!;
    const b = lnodes.get(e.to)!;
    const chain: LNode[] = [a];
    if (b.layer - a.layer > 1) {
      for (let l = a.layer + 1; l < b.layer; l++) {
        const dl: LNode = { id: 'dummy:' + dummyCount++, real: null, layer: l, order: 0, w: 12, h: 12, x: 0, y: 0 };
        ensureLayer(l).push(dl);
        chain.push(dl);
      }
    }
    chain.push(b);
    ledges.push({ orig: e, chain });
  }

  // adjacency between consecutive layer members (using the chains, includes dummies)
  const upN = new Map<LNode, LNode[]>(); // neighbours in the previous layer
  const downN = new Map<LNode, LNode[]>(); // neighbours in the next layer
  for (const arr of layers) for (const ln of arr) (upN.set(ln, []), downN.set(ln, []));
  for (const le of ledges) {
    for (let i = 0; i + 1 < le.chain.length; i++) {
      const u = le.chain[i]!;
      const v = le.chain[i + 1]!;
      downN.get(u)!.push(v);
      upN.get(v)!.push(u);
    }
  }

  // initial order within each layer: stable by (seq, id) so it never depends on hash order
  const seedKey = (ln: LNode): string => {
    const s = ln.real && ln.real.seq != null ? String(ln.real.seq).padStart(9, '0') : '999999999';
    return s + ':' + ln.id;
  };
  for (const arr of layers) {
    arr.sort((p, r) => (seedKey(p) < seedKey(r) ? -1 : seedKey(p) > seedKey(r) ? 1 : 0));
    arr.forEach((ln, i) => (ln.order = i));
  }

  // 3. barycenter crossing reduction — a few deterministic down+up sweeps.
  const bary = (ln: LNode, side: Map<LNode, LNode[]>): number => {
    const nb = side.get(ln)!;
    if (!nb.length) return ln.order;
    let s = 0;
    for (const m of nb) s += m.order;
    return s / nb.length;
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let l = 1; l < layers.length; l++) {
      const arr = layers[l]!;
      const key = new Map(arr.map((ln) => [ln, bary(ln, upN)]));
      arr.sort((p, r) => key.get(p)! - key.get(r)! || p.order - r.order);
      arr.forEach((ln, i) => (ln.order = i));
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      const arr = layers[l]!;
      const key = new Map(arr.map((ln) => [ln, bary(ln, downN)]));
      arr.sort((p, r) => key.get(p)! - key.get(r)! || p.order - r.order);
      arr.forEach((ln, i) => (ln.order = i));
    }
  }

  // 4a. x per layer (column), from cumulative max column widths.
  const colW = layers.map((arr) => arr.reduce((m, ln) => Math.max(m, ln.w), 0));
  const colX: number[] = [];
  let cx = PAD;
  for (let l = 0; l < layers.length; l++) {
    colX[l] = cx + colW[l]! / 2; // centre-x of the column
    cx += colW[l]! + COL_GAP;
  }
  // 4b. baseline y: a uniform slot height, every layer CENTRED. This can never
  // overlap and never diverges — a single-node column lands on the centre line, so
  // a linear trace draws as a straight left→right chain.
  let slotH = 0;
  for (const arr of layers) for (const ln of arr) slotH = Math.max(slotH, ln.h);
  slotH += ROW_GAP;
  const maxRows = Math.max(1, ...layers.map((a) => a.length));
  const fullH = maxRows * slotH;
  for (const arr of layers) {
    const off = PAD + (fullH - arr.length * slotH) / 2;
    arr.forEach((ln, i) => (ln.y = off + i * slotH + slotH / 2));
  }
  // 4c. bounded straightening: pull each node toward the barycentre of its
  // neighbours, but clamp within its order-slot [lo, hi] so it can neither overlap
  // a sibling nor run away. A few symmetric sweeps align fan-outs to their parent.
  const slot = new Map<LNode, { lo: number; hi: number }>();
  for (const arr of layers) {
    for (let i = 0; i < arr.length; i++) {
      slot.set(arr[i]!, { lo: PAD + i * slotH + arr[i]!.h / 2, hi: PAD + fullH - (arr.length - 1 - i) * slotH - arr[i]!.h / 2 });
    }
  }
  const align = (arr: LNode[], side: Map<LNode, LNode[]>): void => {
    for (let i = 0; i < arr.length; i++) {
      const ln = arr[i]!;
      const nb = side.get(ln)!;
      if (!nb.length) continue;
      let want = 0;
      for (const m of nb) want += m.y;
      want /= nb.length;
      const b = slot.get(ln)!;
      const floor = i > 0 ? Math.max(b.lo, arr[i - 1]!.y + slotH) : b.lo;
      ln.y = Math.min(b.hi, Math.max(floor, want));
    }
  };
  for (let pass = 0; pass < 5; pass++) {
    for (let l = 1; l < layers.length; l++) align(layers[l]!, upN);
    for (let l = layers.length - 2; l >= 0; l--) align(layers[l]!, downN);
  }

  // write coordinates back to the real nodes (top-left origin for the renderer)
  let maxX = 0;
  let maxY = 0;
  for (const arr of layers) {
    for (const ln of arr) {
      ln.x = colX[ln.layer]!;
      if (ln.real) {
        ln.real.x = ln.x - ln.w / 2;
        ln.real.y = ln.y - ln.h / 2;
        ln.real.layer = ln.layer;
      }
      maxX = Math.max(maxX, ln.x + ln.w / 2);
      maxY = Math.max(maxY, ln.y + ln.h / 2);
    }
  }
  // route edges through their chain centres
  for (const le of ledges) {
    le.orig.points = le.chain.map((ln) => ({ x: Math.round(ln.x * 100) / 100, y: Math.round(ln.y * 100) / 100 }));
  }
  for (const n of nodes) {
    n.x = Math.round(n.x * 100) / 100;
    n.y = Math.round(n.y * 100) / 100;
  }
  return { width: Math.round(maxX + PAD), height: Math.round(maxY + PAD) };
}

// ── public entry point ────────────────────────────────────────────────────────
/**
 * Project a session story (+ combos) into a positioned trace DAG. Pure and
 * deterministic — the same inputs always yield byte-identical coordinates.
 */
export function buildTrace(story: SessionStory, combos: ComboEvidence[], opts?: TraceOpts): TraceView {
  const o = opts ?? {};
  const model = buildModel(story, combos);
  const whole = !!o.whole;
  const depth = o.depth && o.depth > 0 ? o.depth : 2;
  const expand = new Set(o.expand ?? []);

  let root: string | null = null;
  let keep: Set<string>;
  if (whole || !model.defaultRoot) {
    keep = new Set(model.nodes.keys());
    root = whole ? null : model.defaultRoot;
  } else {
    root = o.root && model.nodes.has(o.root) ? o.root : model.defaultRoot;
    keep = subgraph(model, root!, depth);
  }

  const { nodes, edges } = applyExpand(model, keep, expand);
  const { width, height } = layout(nodes, edges);

  return {
    session_id: story.session_id,
    detailed: !whole,
    root,
    depth: whole ? ALL_DEPTH : depth,
    roots: model.roots,
    nodes,
    edges,
    width,
    height,
    counts: { nodes: nodes.length, edges: edges.length },
  };
}
