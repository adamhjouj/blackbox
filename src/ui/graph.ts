export const GRAPH_JS = String.raw`
let graphCanvas = null;

function renderGraphView() {
  const view = h('section', { className: 'graph-view', 'aria-label': 'Session provenance graph' });
  view.append(h('div', { id: 'graphMount' }));
  setTimeout(function() { renderGraphPanel(); }, 0);
  return view;
}

function renderGraphPanel() {
  const mount = document.getElementById('graphMount');
  if (!mount) return;
  destroyGraphCanvas();
  mount.textContent = '';

  const scope = h('div', { className: 'seg', role: 'group', 'aria-label': 'Graph scope' },
    h('button', { className: !S.graphWhole ? 'active' : '', type: 'button', textContent: 'Focused', 'aria-pressed': String(!S.graphWhole), onclick: function() { setGraphScope(false); } }),
    h('button', { className: S.graphWhole ? 'active' : '', type: 'button', textContent: 'Entire session', 'aria-pressed': String(S.graphWhole), onclick: function() { setGraphScope(true); } })
  );
  const zoom = h('div', { className: 'seg', role: 'group', 'aria-label': 'Zoom' },
    h('button', { className: 'icon', type: 'button', textContent: '−', 'aria-label': 'Zoom out', onclick: function() { if (graphCanvas) graphCanvas.zoom(0.8); } }),
    h('button', { type: 'button', textContent: 'Fit', onclick: function() { if (graphCanvas) graphCanvas.fit(); } }),
    h('button', { className: 'icon', type: 'button', textContent: '+', 'aria-label': 'Zoom in', onclick: function() { if (graphCanvas) graphCanvas.zoom(1.25); } })
  );
  const toolbar = h('div', { className: 'graph-toolbar' },
    scope, zoom,
    h('span', { id: 'graphCount', className: 'graph-count', textContent: S.graph ? '' : 'Loading graph' }),
    h('span', { className: 'graph-hint', textContent: 'read left → right · prompt → action → artifact · click a node for detail' })
  );

  const legend = h('div', { className: 'graph-legendbar', 'aria-label': 'Graph legend' },
    h('span', null, h('span', { className: 'k prompt', 'aria-hidden': 'true', textContent: '●' }), ' prompt'),
    h('span', null, h('span', { className: 'k action', 'aria-hidden': 'true', textContent: '●' }), ' action'),
    h('span', null, h('span', { className: 'k file', 'aria-hidden': 'true', textContent: '◼' }), ' file'),
    h('span', null, h('span', { className: 'k commit', 'aria-hidden': 'true', textContent: '◼' }), ' commit'),
    h('span', null, h('span', { className: 'k danger', 'aria-hidden': 'true', textContent: '●' }), ' flagged finding / host')
  );
  const canvas = h('div', { className: 'graph-canvas' }, h('div', { id: 'graphStage', className: 'graph-stage', 'aria-label': 'Interactive provenance graph' }), legend);
  mount.append(toolbar, h('div', { className: 'graph-layout' }, canvas, h('aside', { id: 'graphDetail', className: 'gdetail', 'aria-label': 'Selected node detail' })));

  if (S.graph) drawFlowGraph();
  else { renderGraphLoading(); loadGraph(true); }
}

function graphQuery() {
  const query = ['whole=1'];
  if (S.graphExpand.length) query.push('expand=' + encodeURIComponent(S.graphExpand.join(',')));
  return '?' + query.join('&');
}

async function loadGraph(showLoading) {
  if (!S.route.id || S.route.tab !== 'graph') return;
  const request = ++S.graphRequest;
  const sessionId = S.route.id;
  const query = graphQuery();
  S.graphLoading = true;
  if (showLoading) renderGraphLoading();
  try {
    const trace = await api('/api/session/' + encodeURIComponent(sessionId) + '/trace' + query);
    if (request !== S.graphRequest || S.route.id !== sessionId || S.route.tab !== 'graph' || query !== graphQuery()) return;
    if (S.graphPendingSeq != null) {
      const pending = Number(S.graphPendingSeq);
      const match = (trace.nodes || []).find(function(node) { return Number(node.seq) === pending; });
      S.graphPendingSeq = null;
      if (match) { S.graphSelected = match.id; S.graphPendingCenter = true; }
      else showToast('This event is recorded in Activity but is not a projected graph node');
    }
    // fp is taken from the wire shape BEFORE the client layout mutates positions,
    // so poll re-fetches compare server-to-server and idle polls never re-render.
    const fp = query + '|' + JSON.stringify(trace);
    const stageMissing = !document.getElementById('graphStage');
    if (fp !== S.graphFp || stageMissing) {
      S.graph = trace;
      S.graphFp = fp;
      renderGraphPanel();
    }
  } catch (_) {
    if (request === S.graphRequest) renderGraphError();
  } finally {
    if (request === S.graphRequest) S.graphLoading = false;
  }
}

function renderGraphLoading() {
  const stage = document.getElementById('graphStage');
  if (!stage) return;
  stage.textContent = '';
  stage.append(h('div', { className: 'graph-empty', 'aria-busy': 'true' },
    h('div', { className: 'graph-loading-line' }),
    h('p', { textContent: 'Building a deterministic evidence map…' })
  ));
}

function renderGraphError() {
  const stage = document.getElementById('graphStage');
  if (!stage) return;
  stage.textContent = '';
  stage.append(h('div', { className: 'graph-empty' },
    h('h3', { textContent: 'The provenance graph could not be loaded' }),
    h('p', { textContent: 'The session remains available. Retry the read-only graph projection.' }),
    h('button', { className: 'secondary-button', type: 'button', textContent: 'Retry', onclick: function() { loadGraph(true); } })
  ));
}

function setGraphScope(whole) {
  if (S.graphWhole === whole) return;
  S.graphWhole = whole;
  S.graphViewport = null;
  renderGraphPanel();
}

function toggleGraphDirectory(id) {
  const index = S.graphExpand.indexOf(id);
  if (index >= 0) S.graphExpand.splice(index, 1); else S.graphExpand.push(id);
  S.graphViewport = null;
  S.graph = null;
  S.graphFp = '';
  renderGraphPanel();
}

function openTurnInGraph(turn, index) {
  S.graphSelected = 'p:' + (turn.prompt_id || '#' + index);
  S.graphPendingCenter = true;
  S.graphViewport = null;
  setRoute(sessionHref(S.route.id, 'graph'));
}

function openEventInGraph(seq) {
  S.graphPendingSeq = Number(seq);
  S.graphPendingCenter = true;
  S.graphWhole = true;
  S.graphViewport = null;
  setRoute(sessionHref(S.route.id, 'graph'));
}

function openGraphNodeInActivity(node) {
  if (!node || node.seq == null || !S.story) return;
  const index = turnIndexForSeq(node.seq);
  if (index >= 0) {
    const turn = S.story.turns[index];
    S.expanded.add(turn.prompt_id || 'turn-' + index);
  }
  setRoute(sessionHref(S.route.id, 'activity'));
  setTimeout(function() {
    const exact = document.getElementById('event-' + Number(node.seq));
    const turn = index >= 0 ? document.getElementById('turn-' + (index + 1)) : null;
    const target = exact || turn;
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 80);
}

/* ── scope: Entire session, or only tainted prompts and their chains ─────── */

function graphScope(trace) {
  if (S.graphWhole) return { nodes: trace.nodes.slice(), edges: trace.edges.slice() };
  const risk = trace.nodes.filter(function(node) { return node.risk; });
  if (!risk.length) return null;
  const fwd = {}, rev = {};
  trace.edges.forEach(function(edge) {
    (fwd[edge.from] = fwd[edge.from] || []).push(edge.to);
    (rev[edge.to] = rev[edge.to] || []).push(edge.from);
  });
  function walk(seed, adj, visited) {
    const stack = [seed];
    visited.add(seed);
    while (stack.length) {
      const current = stack.pop();
      (adj[current] || []).forEach(function(next) {
        if (!visited.has(next)) { visited.add(next); stack.push(next); }
      });
    }
  }
  const up = new Set(), down = new Set();
  risk.forEach(function(node) { walk(node.id, rev, up); walk(node.id, fwd, down); });
  const keep = new Set();
  up.forEach(function(id) { keep.add(id); });
  down.forEach(function(id) { keep.add(id); });
  return {
    nodes: trace.nodes.filter(function(node) { return keep.has(node.id); }),
    edges: trace.edges.filter(function(edge) { return keep.has(edge.from) && keep.has(edge.to); })
  };
}

/* ── layout: kind → column (prompt | action | artifact), barycenter rows ──── */

const G_NW = 232, G_NH = 54, G_PITCH = 64, G_COLW = 350, G_X0 = 30, G_Y0 = 40;

// Semantic columns, not graph-theoretic layers: the record reads left → right
// as prompt → action → artifact. Consequent edges (finding → step) simply draw
// back-loops, which is honest — a self-combo IS a loop in the causal record.
function flowColumn(node) {
  if (node.kind === 'prompt') return 0;
  if (node.kind === 'step') return 1;
  return 2;
}

function flowLayout(nodes, edges) {
  const byCol = [];
  nodes.forEach(function(node) {
    const col = flowColumn(node);
    (byCol[col] = byCol[col] || []).push(node);
  });
  const cols = byCol.filter(function(list) { return list && list.length; });
  const inMap = {};
  edges.forEach(function(edge) { (inMap[edge.to] = inMap[edge.to] || []).push(edge.from); });
  const yOf = {};
  cols.forEach(function(list, ci) {
    // temporal order within a column, then pull rows toward the average of
    // their already-placed predecessors so chains read straight across.
    list.sort(function(a, b) {
      const sa = a.seq == null ? Number.MAX_SAFE_INTEGER : Number(a.seq);
      const sb = b.seq == null ? Number.MAX_SAFE_INTEGER : Number(b.seq);
      return sa - sb || a.y - b.y;
    });
    let cursor = G_Y0;
    list.forEach(function(node) {
      const preds = (inMap[node.id] || []).filter(function(id) { return yOf[id] != null; });
      let desired = null;
      if (preds.length) {
        let sum = 0;
        preds.forEach(function(id) { sum += yOf[id]; });
        desired = sum / preds.length;
      }
      const y = desired == null ? cursor : Math.max(desired, cursor);
      node.x = G_X0 + ci * G_COLW;
      node.y = y;
      node.w = G_NW;
      node.h = G_NH;
      yOf[node.id] = y;
      cursor = y + G_PITCH;
    });
  });
  let width = 0, height = 0;
  nodes.forEach(function(node) {
    width = Math.max(width, node.x + G_NW);
    height = Math.max(height, node.y + G_NH);
  });
  return { width: width + 40, height: height + 60 };
}

/* ── draw ─────────────────────────────────────────────────────────────────── */

function graphEmpty(title, copy) {
  return h('div', { className: 'graph-empty' }, h('h3', { textContent: title }), h('p', { textContent: copy }));
}

function edgeDanger(edge, byId) {
  if (edge.rel === 'flagged' || edge.rel === 'sent') return true;
  const from = byId[edge.from], to = byId[edge.to];
  return !!(from && to && from.risk && to.risk);
}

function drawFlowGraph() {
  const stage = document.getElementById('graphStage');
  const count = document.getElementById('graphCount');
  if (!stage) return;
  destroyGraphCanvas();
  stage.textContent = '';
  const trace = S.graph;
  if (!trace || !trace.nodes || !trace.nodes.length) {
    if (count) count.textContent = '0 nodes';
    stage.append(graphEmpty('No provenance graph', 'This session has no projected causal relationships yet.'));
    renderGraphDetail(null);
    return;
  }
  const scoped = graphScope(trace);
  if (!scoped) {
    if (count) count.textContent = '0 nodes';
    const empty = graphEmpty('No flagged chains', 'Nothing in this session is flagged. The Focused view only shows tainted prompts and their chains.');
    empty.append(h('button', { className: 'secondary-button', type: 'button', textContent: 'Show entire session', onclick: function() { setGraphScope(true); } }));
    stage.append(empty);
    renderGraphDetail(null);
    return;
  }
  if (!S.graphSelected || !scoped.nodes.some(function(node) { return node.id === S.graphSelected; })) {
    // Default to a node that actually has chains to walk: a connected risk node,
    // else any risk node, else the first node.
    const connected = new Set();
    scoped.edges.forEach(function(edge) { connected.add(edge.from); connected.add(edge.to); });
    const firstRisk = scoped.nodes.find(function(node) { return node.risk && connected.has(node.id); }) ||
      scoped.nodes.find(function(node) { return node.risk; });
    S.graphSelected = (firstRisk || scoped.nodes[0]).id;
  }
  const size = flowLayout(scoped.nodes, scoped.edges);
  if (count) count.textContent = scoped.nodes.length + ' nodes · ' + scoped.edges.length + ' connections';

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'graph-svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Provenance graph with ' + scoped.nodes.length + ' nodes and ' + scoped.edges.length + ' connections');
  const world = document.createElementNS(ns, 'g');
  world.setAttribute('class', 'graph-world');
  const edgeLayer = document.createElementNS(ns, 'g');
  const nodeLayer = document.createElementNS(ns, 'g');
  world.append(edgeLayer, nodeLayer);
  svg.append(world);
  stage.append(svg);

  const byId = {};
  scoped.nodes.forEach(function(node) { byId[node.id] = node; });
  scoped.edges.forEach(function(edge) {
    const from = byId[edge.from], to = byId[edge.to];
    if (!from || !to) return;
    const x1 = from.x + G_NW, y1 = from.y + G_NH / 2;
    const x2 = to.x, y2 = to.y + G_NH / 2;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 70) + ' ' + y1 + ', ' + (x2 - 70) + ' ' + y2 + ', ' + x2 + ' ' + y2);
    path.setAttribute('class', 'graph-edge' + (edgeDanger(edge, byId) ? ' danger' : ''));
    path.setAttribute('data-from', edge.from);
    path.setAttribute('data-to', edge.to);
    const title = document.createElementNS(ns, 'title');
    title.textContent = from.label + ' ' + graphRelationLabel(edge.rel) + ' ' + to.label;
    path.append(title);
    edgeLayer.append(path);
  });

  scoped.nodes.forEach(function(node) {
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('class', 'gnode kind-' + node.kind + (node.risk ? ' danger' : '') + (node.id === S.graphSelected ? ' selected' : ''));
    group.setAttribute('transform', 'translate(' + node.x + ',' + node.y + ')');
    group.setAttribute('data-node-id', node.id);
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'button');
    group.setAttribute('aria-label', graphKindLabel(node.kind) + ': ' + node.label + (node.sub ? ', ' + node.sub : '') + (node.risk ? ', needs review' : ''));
    const title = document.createElementNS(ns, 'title');
    title.textContent = graphKindLabel(node.kind) + ': ' + node.label + (node.sub ? ' — ' + node.sub : '');
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', 'card');
    rect.setAttribute('x', '0'); rect.setAttribute('y', '0');
    rect.setAttribute('width', String(G_NW)); rect.setAttribute('height', String(G_NH));
    rect.setAttribute('rx', '9');
    group.append(title, rect);
    if (node.kind === 'file' || node.kind === 'dir' || node.kind === 'commit') {
      const dot = document.createElementNS(ns, 'rect');
      dot.setAttribute('class', 'gdot');
      dot.setAttribute('x', '13.5'); dot.setAttribute('y', '13.5');
      dot.setAttribute('width', '7'); dot.setAttribute('height', '7');
      dot.setAttribute('rx', '1.5');
      group.append(dot);
    } else {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('class', 'gdot');
      dot.setAttribute('cx', '17'); dot.setAttribute('cy', '17'); dot.setAttribute('r', '3.5');
      group.append(dot);
    }
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('class', 'glabel');
    label.setAttribute('x', '28'); label.setAttribute('y', '21');
    label.textContent = clampText(node.label, 29);
    group.append(label);
    const sub = document.createElementNS(ns, 'text');
    sub.setAttribute('class', 'gsub');
    sub.setAttribute('x', '14'); sub.setAttribute('y', '41');
    sub.textContent = clampText(node.sub || graphKindLabel(node.kind), 36);
    group.append(sub);
    group.addEventListener('click', function(event) { event.stopPropagation(); selectGraphNode(node.id, false); });
    group.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectGraphNode(node.id, true); }
    });
    nodeLayer.append(group);
  });

  graphCanvas = mountGraphCanvas(stage, svg, world, { nodes: scoped.nodes, width: size.width, height: size.height });
  updateGraphEmphasis();
  renderGraphDetail(scoped);
  if (S.graphPendingCenter && S.graphSelected) {
    requestAnimationFrame(function() {
      if (graphCanvas) graphCanvas.center(S.graphSelected);
      S.graphPendingCenter = false;
    });
  }
}

function selectGraphNode(id, center) {
  if (!S.graph) return;
  S.graphSelected = id;
  const scoped = graphScope(S.graph);
  updateGraphEmphasis();
  renderGraphDetail(scoped);
  if (center && graphCanvas) graphCanvas.center(id);
}

function updateGraphEmphasis() {
  document.querySelectorAll('.gnode').forEach(function(element) {
    element.classList.toggle('selected', element.getAttribute('data-node-id') === S.graphSelected);
  });
  document.querySelectorAll('.graph-edge').forEach(function(element) {
    const incident = element.getAttribute('data-from') === S.graphSelected || element.getAttribute('data-to') === S.graphSelected;
    element.classList.toggle('active', incident);
  });
}

/* ── the detail panel ─────────────────────────────────────────────────────── */

function renderGraphDetail(scoped) {
  const host = document.getElementById('graphDetail');
  if (!host) return;
  host.textContent = '';
  const selected = scoped && scoped.nodes.find(function(node) { return node.id === S.graphSelected; });
  if (!selected) {
    host.append(
      h('div', { className: 'gd-title', textContent: 'Select a node' }),
      h('div', { className: 'gd-sub', textContent: 'One click shows what led to it, what followed, and the underlying record.' })
    );
    return;
  }
  const incoming = scoped.edges.filter(function(edge) { return edge.to === selected.id; });
  const outgoing = scoped.edges.filter(function(edge) { return edge.from === selected.id; });
  const byId = {};
  scoped.nodes.forEach(function(node) { byId[node.id] = node; });

  host.append(
    h('div', { className: 'gd-title', textContent: selected.label }),
    h('div', { className: 'gd-sub', textContent: selected.sub || graphKindLabel(selected.kind) })
  );
  const facts = h('dl', { className: 'gd-facts' });
  facts.append(h('dt', { textContent: 'Type' }), h('dd', { textContent: graphKindLabel(selected.kind) }));
  if (selected.seq != null) facts.append(h('dt', { textContent: 'Event' }), h('dd', { textContent: String(selected.seq) }));
  facts.append(h('dt', { textContent: 'Connections' }), h('dd', { textContent: String(incoming.length + outgoing.length) }));
  facts.append(h('dt', { textContent: 'Status' }), h('dd', { className: selected.risk ? 'danger' : '', textContent: selected.risk ? 'Needs review' : 'Recorded' }));
  host.append(facts);

  function relationRow(edge, otherId) {
    const other = byId[otherId];
    if (!other) return null;
    const danger = edge.rel === 'flagged' || edge.rel === 'sent';
    return h('button', { className: 'gd-rel', type: 'button', onclick: function() { selectGraphNode(otherId, true); } },
      h('span', { className: 'gd-via' + (danger ? ' danger' : ''), textContent: graphRelationLabel(edge.rel) }),
      h('span', { className: 'gd-rel-label', textContent: other.label }));
  }
  if (incoming.length) {
    host.append(h('div', { className: 'mlabel gd-sec', textContent: 'What led here' }));
    incoming.slice(0, 8).forEach(function(edge) { host.append(relationRow(edge, edge.from)); });
  }
  if (outgoing.length) {
    host.append(h('div', { className: 'mlabel gd-sec', textContent: 'What followed' }));
    outgoing.slice(0, 8).forEach(function(edge) { host.append(relationRow(edge, edge.to)); });
  }

  if (selected.seq != null) {
    host.append(h('button', { className: 'gd-open' + (selected.risk ? '' : ' plain'), type: 'button', textContent: 'Open evidence record →', onclick: function() { openEvidence(selected.seq); } }));
  }
  const actions = h('div', { className: 'gd-actions' });
  if (selected.seq != null) actions.append(h('button', { className: 'quiet-button', type: 'button', textContent: 'Show in Activity', onclick: function() { openGraphNodeInActivity(selected); } }));
  if (selected.kind === 'dir') actions.append(h('button', { className: 'quiet-button', type: 'button', textContent: S.graphExpand.indexOf(selected.id) >= 0 ? 'Collapse files' : 'Expand files', onclick: function() { toggleGraphDirectory(selected.id); } }));
  if (actions.children.length) host.append(actions);
}

function graphKindLabel(kind) {
  return { prompt: 'Prompt', step: 'Action', file: 'File', dir: 'Folder', commit: 'Commit', finding: 'Finding', host: 'External host' }[kind] || cap(kind);
}

function graphRelationLabel(rel) {
  return { caused: 'caused', wrote: 'wrote', committed: 'recorded with', flagged: 'triggered', sent: 'sent to' }[rel] || rel;
}

/* ── pan / zoom canvas (wheel zooms toward the cursor) ────────────────────── */

function mountGraphCanvas(stage, svg, world, layout) {
  const listeners = [];
  let resizeTimer = null;
  function on(target, event, handler, options) { target.addEventListener(event, handler, options); listeners.push([target, event, handler, options]); }
  const stageWidth = stage.clientWidth || 900;
  const saved = S.graphViewport;
  const restoreSaved = !!saved && Number(saved.width) > 0 && Math.abs(Number(saved.width) - stageWidth) < 80;
  let x = restoreSaved ? Number(saved.x) || 0 : 0;
  let y = restoreSaved ? Number(saved.y) || 0 : 0;
  let zoom = restoreSaved ? Number(saved.zoom) || 1 : 1;
  function apply() {
    world.setAttribute('transform', 'translate(' + Math.round(x * 10) / 10 + ' ' + Math.round(y * 10) / 10 + ') scale(' + Math.round(zoom * 1000) / 1000 + ')');
    S.graphViewport = { x: x, y: y, zoom: zoom, width: stage.clientWidth || stageWidth, height: stage.clientHeight || 620 };
  }
  function fit() {
    const width = stage.clientWidth || 900;
    const height = stage.clientHeight || 620;
    // Width-fit only (the prototype behaviour): a long session reads as a
    // scrollable timeline you pan down — cards never shrink below readable
    // just to cram the whole height into the stage.
    zoom = Math.max(0.5, Math.min((width - 52) / Math.max(layout.width, 1), 1.1));
    x = Math.max(14, (width - layout.width * zoom) / 2);
    const fitsVertically = layout.height * zoom <= height - 28;
    y = fitsVertically ? (height - layout.height * zoom) / 2 : 14;
    apply();
  }
  function zoomBy(factor, centerX, centerY) {
    const width = stage.clientWidth || 900;
    const height = stage.clientHeight || 620;
    const cx = centerX == null ? width / 2 : centerX;
    const cy = centerY == null ? height / 2 : centerY;
    const next = Math.max(0.04, Math.min(2.8, zoom * factor));
    const ratio = next / zoom;
    x = cx - (cx - x) * ratio;
    y = cy - (cy - y) * ratio;
    zoom = next;
    apply();
  }
  function center(id) {
    const node = layout.nodes.find(function(item) { return item.id === id; });
    if (!node) return;
    const width = stage.clientWidth || 900;
    const height = stage.clientHeight || 620;
    zoom = Math.max(zoom, 0.78);
    x = width / 2 - (node.x + node.w / 2) * zoom;
    y = height / 2 - (node.y + node.h / 2) * zoom;
    apply();
  }
  on(svg, 'wheel', function(event) {
    event.preventDefault();
    const bounds = svg.getBoundingClientRect();
    const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 120 : event.deltaY;
    const limited = Math.max(-60, Math.min(60, pixels));
    zoomBy(Math.exp(-limited * 0.0008), event.clientX - bounds.left, event.clientY - bounds.top);
  }, { passive: false });
  let panning = false, startX = 0, startY = 0, originX = 0, originY = 0;
  on(svg, 'pointerdown', function(event) {
    if (event.target.closest && event.target.closest('.gnode')) return;
    panning = true; startX = event.clientX; startY = event.clientY; originX = x; originY = y;
    svg.classList.add('panning');
    try { svg.setPointerCapture(event.pointerId); } catch (_) {}
  });
  on(svg, 'pointermove', function(event) {
    if (!panning) return;
    x = originX + event.clientX - startX;
    y = originY + event.clientY - startY;
    apply();
  });
  function stopPan(event) {
    panning = false; svg.classList.remove('panning');
    try { if (event && event.pointerId != null) svg.releasePointerCapture(event.pointerId); } catch (_) {}
  }
  on(svg, 'pointerup', stopPan);
  on(svg, 'pointercancel', stopPan);
  on(window, 'resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 120);
  });
  if (restoreSaved) apply();
  else setTimeout(fit, 0);
  return {
    fit: fit,
    zoom: function(factor) { zoomBy(factor); },
    center: center,
    destroy: function() {
      clearTimeout(resizeTimer);
      listeners.forEach(function(item) { item[0].removeEventListener(item[1], item[2], item[3]); });
      listeners.length = 0;
    }
  };
}

function destroyGraphCanvas() {
  if (graphCanvas && graphCanvas.destroy) graphCanvas.destroy();
  graphCanvas = null;
}
`;
