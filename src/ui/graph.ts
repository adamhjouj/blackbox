export const GRAPH_JS = String.raw`
let graphCanvas = null;

function renderGraphView() {
  const view = h('section', { className: 'graph-workspace', 'aria-label': 'Session investigation graph' });
  view.append(h('div', { id: 'graphMount' }));
  setTimeout(function() { renderGraphPanel(); }, 0);
  return view;
}

function renderGraphPanel() {
  const mount = document.getElementById('graphMount');
  if (!mount) return;
  destroyGraphCanvas();
  mount.textContent = '';

  const trace = S.graph;
  const root = graphRootSelect(trace);
  const depth = h('select', { className: 'select-field', 'aria-label': 'Causal distance' },
    h('option', { value: '1', textContent: '1 hop' }),
    h('option', { value: '2', textContent: '2 hops' }),
    h('option', { value: '3', textContent: '3 hops' }),
    h('option', { value: 'all', textContent: 'All connected' })
  );
  depth.value = S.graphDepth;
  depth.disabled = S.graphWhole;

  const filter = h('select', { className: 'select-field', 'aria-label': 'Highlight node type' },
    h('option', { value: 'all', textContent: 'All node types' }),
    h('option', { value: 'risk', textContent: 'Risk nodes' }),
    h('option', { value: 'prompt', textContent: 'Prompts' }),
    h('option', { value: 'step', textContent: 'Actions' }),
    h('option', { value: 'file', textContent: 'Files and folders' }),
    h('option', { value: 'commit', textContent: 'Commits' }),
    h('option', { value: 'host', textContent: 'Findings and hosts' })
  );
  filter.value = S.graphFilter;
  const search = h('input', {
    className: 'text-field graph-search', type: 'search', value: S.graphSearch,
    placeholder: 'Find a prompt, path, action, commit, or host…', autocomplete: 'off',
    'aria-label': 'Search graph nodes'
  });

  const focused = h('button', {
    className: 'scope-button' + (!S.graphWhole ? ' active' : ''), type: 'button',
    textContent: 'Focused', 'aria-pressed': String(!S.graphWhole),
    onclick: function() { setGraphScope(false); }
  });
  const whole = h('button', {
    className: 'scope-button' + (S.graphWhole ? ' active' : ''), type: 'button',
    textContent: 'Entire session', 'aria-pressed': String(S.graphWhole),
    onclick: function() { setGraphScope(true); }
  });

  const controls = h('div', { className: 'graph-controls' },
    graphControlField('Start from', root),
    h('div', { className: 'graph-control-field graph-scope-field' },
      h('span', { className: 'control-label', textContent: 'View' }),
      h('div', { className: 'scope-switch', role: 'group', 'aria-label': 'Graph view' }, focused, whole)
    ),
    h('div', { className: 'graph-search-field' }, search, h('span', { id: 'graphMatchCount', className: 'graph-match-count' })),
    h('details', { className: 'graph-options' },
      h('summary', { textContent: 'Options' }),
      h('div', { className: 'graph-options-grid' },
        graphControlField('Distance', depth),
        graphControlField('Highlight', filter),
        h('button', { className: 'quiet-button', type: 'button', textContent: 'Reset graph', onclick: resetGraph })
      )
    )
  );

  const canvasBar = h('div', { className: 'graph-canvas-bar' },
    h('div', null,
      h('strong', { textContent: graphScopeTitle(trace) }),
      h('span', { id: 'graphCount', textContent: trace ? trace.counts.nodes + ' nodes · ' + trace.counts.edges + ' connections' : 'Loading graph' })
    ),
    h('div', { className: 'graph-canvas-actions' },
      S.graphExpand.length ? h('button', { className: 'quiet-button', type: 'button', textContent: 'Collapse file groups', onclick: collapseGraphGroups }) : null,
      h('button', { className: 'icon-button', type: 'button', textContent: '−', 'aria-label': 'Zoom out', onclick: function() { if (graphCanvas) graphCanvas.zoom(0.9); } }),
      h('button', { className: 'secondary-button', type: 'button', textContent: 'Fit', onclick: function() { if (graphCanvas) graphCanvas.fit(); } }),
      h('button', { className: 'icon-button', type: 'button', textContent: '+', 'aria-label': 'Zoom in', onclick: function() { if (graphCanvas) graphCanvas.zoom(1.1); } }),
      h('button', { className: 'quiet-button graph-canvas-fullscreen', type: 'button', textContent: 'Full screen', onclick: toggleGraphFullscreen })
    )
  );

  const stage = h('div', { id: 'graphStage', className: 'graph-stage', 'aria-label': 'Interactive causal graph' });
  const canvas = h('div', { className: 'graph-canvas' },
    canvasBar,
    stage,
    h('div', { className: 'graph-help' }, h('strong', { textContent: 'Read left → right:' }), ' prompt → action → file, commit, or finding. Click once for details · drag to pan · scroll to zoom.'),
    graphLegend()
  );
  const inspector = h('aside', { id: 'graphInspector', className: 'graph-inspector', 'aria-label': 'Selected graph node' });
  mount.append(controls, h('div', { className: 'graph-layout' }, canvas, inspector));

  root.addEventListener('change', function() { if (root.value) setGraphRoot(root.value); });
  depth.addEventListener('change', function() { S.graphDepth = depth.value; S.graphWhole = false; S.graphViewport = null; loadGraph(true); });
  filter.addEventListener('change', function() { S.graphFilter = filter.value; updateGraphEmphasis(); });
  search.addEventListener('input', function() { S.graphSearch = search.value; updateGraphEmphasis(); });
  search.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') { event.preventDefault(); selectFirstGraphMatch(); }
  });

  if (trace) {
    drawGraph(trace);
    renderGraphInspector(trace);
  } else {
    renderGraphLoading();
    loadGraph(true);
  }
}

function graphControlField(label, control) {
  return h('label', { className: 'graph-control-field' }, h('span', { className: 'control-label', textContent: label }), control);
}

function graphRootSelect(trace) {
  const select = h('select', { className: 'select-field', 'aria-label': 'Trace root' });
  const roots = trace && trace.roots || [];
  const selected = S.graphRoot || trace && trace.root || '';
  const findings = roots.filter(function(item) { return item.kind === 'finding'; });
  const prompts = roots.filter(function(item) { return item.kind === 'prompt'; });
  const listed = findings.concat(prompts).some(function(item) { return item.id === selected; });
  if (selected && !listed) {
    const selectedNode = trace && trace.nodes && trace.nodes.find(function(node) { return node.id === selected; });
    select.append(h('option', { value: selected, textContent: 'Selected · ' + (selectedNode ? selectedNode.label : selected) }));
  }
  if (findings.length) {
    const group = h('optgroup', { label: 'Findings' });
    findings.forEach(function(item) { group.append(h('option', { value: item.id, textContent: 'Review · ' + item.label })); });
    select.append(group);
  }
  if (prompts.length) {
    const group = h('optgroup', { label: 'Prompts' });
    prompts.forEach(function(item) { group.append(h('option', { value: item.id, textContent: clampText(item.label, 72) })); });
    select.append(group);
  }
  if (!roots.length) select.append(h('option', { value: '', textContent: trace ? 'No trace roots' : 'Loading roots…' }));
  select.value = selected;
  select.disabled = S.graphWhole || !roots.length;
  return select;
}

function graphScopeTitle(trace) {
  if (!trace) return 'Preparing the map';
  if (S.graphWhole) return 'Whole-session map';
  const node = trace.nodes && trace.nodes.find(function(item) { return item.id === (S.graphRoot || trace.root); });
  return node ? 'Focused on ' + clampText(node.label, 58) : 'Focused causal trace';
}

function graphQuery() {
  const query = [];
  if (S.graphWhole) query.push('whole=1');
  else {
    query.push('depth=' + encodeURIComponent(S.graphDepth));
    if (S.graphRoot) query.push('root=' + encodeURIComponent(S.graphRoot));
  }
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
    if (!S.graphWhole && !S.graphRoot && trace.root) S.graphRoot = trace.root;
    if (S.graphPendingSeq != null) {
      const pending = Number(S.graphPendingSeq);
      const match = (trace.nodes || []).find(function(node) { return Number(node.seq) === pending; });
      S.graphPendingSeq = null;
      if (match) S.graphSelected = match.id;
      else showToast('This event is recorded in Activity but is not a projected graph node');
    }
    const fp = query + '|' + JSON.stringify(trace);
    const stageMissing = !document.getElementById('graphStage');
    if (fp !== S.graphFp || stageMissing) {
      S.graph = trace;
      S.graphFp = fp;
      if (!S.graphSelected || !trace.nodes.some(function(node) { return node.id === S.graphSelected; })) S.graphSelected = trace.root || trace.nodes[0] && trace.nodes[0].id || null;
      renderGraphPanel();
      if (S.graphSelected) requestAnimationFrame(function() { if (graphCanvas && S.graphPendingCenter) { graphCanvas.center(S.graphSelected); S.graphPendingCenter = false; } });
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
    h('h3', { textContent: 'The investigation graph could not be loaded' }),
    h('p', { textContent: 'The session remains available. Retry the read-only graph projection.' }),
    h('button', { className: 'secondary-button', type: 'button', textContent: 'Retry', onclick: function() { loadGraph(true); } })
  ));
}

function setGraphRoot(id) {
  S.graphRoot = id;
  S.graphWhole = false;
  S.graphSelected = id;
  S.graphViewport = null;
  loadGraph(true);
}

function setGraphScope(whole) {
  if (S.graphWhole === whole) return;
  S.graphWhole = whole;
  S.graphViewport = null;
  loadGraph(true);
}

function resetGraph() {
  S.graphRoot = null;
  S.graphDepth = '2';
  S.graphWhole = false;
  S.graphExpand = [];
  S.graphSelected = null;
  S.graphSearch = '';
  S.graphFilter = 'all';
  S.graphViewport = null;
  S.graph = null;
  S.graphFp = '';
  renderGraphPanel();
}

function collapseGraphGroups() {
  S.graphExpand = [];
  S.graphSelected = null;
  S.graphViewport = null;
  loadGraph(true);
}

function toggleGraphDirectory(id) {
  const index = S.graphExpand.indexOf(id);
  if (index >= 0) S.graphExpand.splice(index, 1); else S.graphExpand.push(id);
  S.graphSelected = null;
  S.graphViewport = null;
  loadGraph(true);
}

function openTurnInGraph(turn, index) {
  S.graphRoot = 'p:' + (turn.prompt_id || '#' + index);
  S.graphWhole = false;
  S.graphDepth = '2';
  S.graphSelected = S.graphRoot;
  S.graphViewport = null;
  S.graph = null;
  S.graphFp = '';
  setRoute(sessionHref(S.route.id, 'graph'));
}

function openEventInGraph(seq) {
  S.graphPendingSeq = Number(seq);
  S.graphPendingCenter = true;
  S.graphWhole = true;
  S.graphViewport = null;
  S.graph = null;
  S.graphFp = '';
  setRoute(sessionHref(S.route.id, 'graph'));
}

function openGraphNodeInActivity(node) {
  if (!node || node.seq == null || !S.story) return;
  const seq = Number(node.seq);
  let turnIndex = -1;
  S.story.turns.some(function(turn, index) {
    const found = (turn.steps || []).some(function(step) { return Number(step.seq) === seq || Number(step.post_seq) === seq; }) ||
      (turn.files_changed || []).some(function(file) { return Number(file.seq) === seq; }) ||
      (turn.commits || []).some(function(commit) { return Number(commit.seq) === seq; });
    if (found) turnIndex = index;
    return found;
  });
  if (turnIndex >= 0) {
    const turn = S.story.turns[turnIndex];
    S.expanded.add(turn.prompt_id || 'turn-' + turnIndex);
  }
  setRoute(sessionHref(S.route.id, 'activity'));
  setTimeout(function() {
    const exact = document.getElementById('event-' + seq);
    const turn = turnIndex >= 0 ? document.getElementById('turn-' + (turnIndex + 1)) : null;
    const target = exact || turn;
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 80);
}

function selectGraphNode(id, center, revealDetails) {
  if (!S.graph || !S.graph.nodes.some(function(node) { return node.id === id; })) return;
  S.graphSelected = id;
  renderGraphInspector(S.graph);
  updateGraphEmphasis();
  if (center && graphCanvas) graphCanvas.center(id);
  if (revealDetails && window.matchMedia('(max-width: 900px)').matches) {
    const inspector = document.getElementById('graphInspector');
    if (inspector) inspector.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function selectFirstGraphMatch() {
  if (!S.graph) return;
  const matches = graphMatchingNodes(S.graph.nodes);
  if (matches.length) selectGraphNode(matches[0].id, true);
}

function graphMatchingNodes(nodes) {
  const query = S.graphSearch.trim().toLowerCase();
  return nodes.filter(function(node) {
    const filterMatch = S.graphFilter === 'all' ||
      S.graphFilter === 'risk' && node.risk ||
      S.graphFilter === 'file' && (node.kind === 'file' || node.kind === 'dir') ||
      S.graphFilter === 'host' && (node.kind === 'host' || node.kind === 'finding') ||
      node.kind === S.graphFilter;
    if (!filterMatch) return false;
    if (!query) return true;
    return [node.label, node.sub, node.kind, node.id].join(' ').toLowerCase().indexOf(query) >= 0;
  });
}

function updateGraphEmphasis() {
  if (!S.graph) return;
  const matchIds = new Set(graphMatchingNodes(S.graph.nodes).map(function(node) { return node.id; }));
  const filtering = S.graphFilter !== 'all' || !!S.graphSearch.trim();
  document.querySelectorAll('.graph-node').forEach(function(element) {
    const id = element.getAttribute('data-node-id');
    const dim = id !== S.graphSelected && filtering && !matchIds.has(id);
    element.classList.toggle('dimmed', dim);
    element.classList.toggle('selected', id === S.graphSelected);
  });
  document.querySelectorAll('.graph-edge').forEach(function(element) {
    const from = element.getAttribute('data-from');
    const to = element.getAttribute('data-to');
    const incident = !S.graphSelected || from === S.graphSelected || to === S.graphSelected;
    const matches = !filtering || matchIds.has(from) && matchIds.has(to);
    element.classList.toggle('dimmed', !matches);
    element.classList.toggle('active', !!S.graphSelected && incident);
  });
  document.querySelectorAll('.graph-edge-label').forEach(function(element) {
    const from = element.getAttribute('data-from');
    const to = element.getAttribute('data-to');
    const incident = !S.graphSelected || from === S.graphSelected || to === S.graphSelected;
    const matches = !filtering || matchIds.has(from) && matchIds.has(to);
    element.classList.toggle('dimmed', !matches);
    element.classList.toggle('active', !!S.graphSelected && incident);
  });
  const counter = document.getElementById('graphMatchCount');
  if (counter) counter.textContent = filtering ? matchIds.size + ' match' + (matchIds.size === 1 ? '' : 'es') : '';
}

function renderGraphInspector(trace) {
  const inspector = document.getElementById('graphInspector');
  if (!inspector) return;
  inspector.textContent = '';
  const selected = trace.nodes.find(function(node) { return node.id === S.graphSelected; });
  if (!selected) {
    inspector.append(
      h('div', { className: 'inspector-empty' },
        h('h3', { textContent: 'Select a node' }),
        h('p', { textContent: 'One click shows what came before it, what came after it, and the underlying record.' })
      ),
      graphRelationGuide()
    );
    return;
  }

  const incoming = trace.edges.filter(function(edge) { return edge.to === selected.id; });
  const outgoing = trace.edges.filter(function(edge) { return edge.from === selected.id; });
  const byId = {};
  trace.nodes.forEach(function(node) { byId[node.id] = node; });
  const top = h('div', { className: 'inspector-top' },
    h('h3', { textContent: selected.label }),
    selected.sub ? h('p', { textContent: selected.sub }) : null
  );
  const facts = h('dl', { className: 'inspector-facts' });
  addKv(facts, 'Type', graphKindLabel(selected.kind));
  addKv(facts, 'Event', selected.seq);
  addKv(facts, 'Connections', incoming.length + outgoing.length);
  if (selected.risk) addKv(facts, 'Status', 'Needs review');

  const actions = h('div', { className: 'inspector-actions' });
  if (!S.graphWhole && selected.id === trace.root) {
    actions.append(h('span', { className: 'inspector-action-note', textContent: 'Current focus' }));
  } else {
    actions.append(h('button', { className: 'secondary-button', type: 'button', textContent: 'Focus here', onclick: function() { setGraphRoot(selected.id); } }));
  }
  if (selected.kind === 'dir') actions.append(h('button', { className: 'secondary-button', type: 'button', textContent: 'Expand files', onclick: function() { toggleGraphDirectory(selected.id); } }));
  if (selected.seq != null) {
    actions.append(
      h('button', { className: 'quiet-button', type: 'button', textContent: 'Open evidence', onclick: function() { openEvidence(selected.seq); } }),
      h('button', { className: 'quiet-button', type: 'button', textContent: 'Show in Prompts', onclick: function() { openGraphNodeInActivity(selected); } })
    );
  }
  inspector.append(top, facts, actions);
  if (incoming.length) inspector.append(graphRelationsSection('What led here', incoming, byId, true));
  if (outgoing.length) inspector.append(graphRelationsSection('What followed', outgoing, byId, false));
  if (!incoming.length && !outgoing.length) inspector.append(h('p', { className: 'inspector-note', textContent: 'No direct relationships are visible at this trace depth.' }));
}

function graphRelationsSection(title, edges, byId, incoming) {
  const section = h('section', { className: 'inspector-relations' }, h('h4', { textContent: title }));
  edges.slice(0, 10).forEach(function(edge) {
    const id = incoming ? edge.from : edge.to;
    const node = byId[id];
    if (!node) return;
    section.append(h('button', { className: 'relation-row', type: 'button', onclick: function() { selectGraphNode(id, true); } },
      h('span', { className: 'relation-type' + (edge.rel === 'flagged' || edge.rel === 'sent' ? ' danger' : ''), textContent: graphRelationLabel(edge.rel) }),
      h('span', { className: 'relation-node', textContent: node.label })
    ));
  });
  return section;
}

function graphRelationGuide() {
  return h('section', { className: 'relation-guide' },
    h('h4', { textContent: 'Connection language' }),
    h('div', { className: 'relation-guide-grid' },
      h('span', null, h('i', { className: 'edge-sample' }), 'caused'),
      h('span', null, h('i', { className: 'edge-sample wrote' }), 'wrote'),
      h('span', null, h('i', { className: 'edge-sample committed' }), 'recorded commit'),
      h('span', null, h('i', { className: 'edge-sample danger' }), 'flagged / sent')
    )
  );
}

function graphLegend() {
  const legend = h('div', { className: 'graph-legend', 'aria-label': 'Graph node legend' });
  [
    ['prompt','Prompt'], ['step','Action'], ['file','File'], ['dir','Folder'],
    ['commit','Commit'], ['finding','Finding'], ['host','Host']
  ].forEach(function(item) {
    legend.append(h('span', { className: 'legend-item' }, h('i', { className: 'legend-dot kind-' + item[0] }), item[1]));
  });
  legend.append(h('span', { className: 'legend-item danger' }, h('i', { className: 'legend-dot' }), 'Needs review'));
  return legend;
}

function graphKindLabel(kind) {
  return { prompt: 'Prompt', step: 'Action', file: 'File', dir: 'Folder', commit: 'Commit', finding: 'Finding', host: 'External host' }[kind] || cap(kind);
}

function graphRelationLabel(rel) {
  return { caused: 'caused', wrote: 'wrote', committed: 'recorded with', flagged: 'triggered', sent: 'sent to' }[rel] || rel;
}

function graphKindMark(kind) {
  return { prompt: 'P', step: 'A', file: 'F', dir: 'D', commit: 'C', finding: '!', host: 'H' }[kind] || '·';
}

function drawGraph(trace) {
  const stage = document.getElementById('graphStage');
  if (!stage) return;
  stage.textContent = '';
  if (!trace.nodes || !trace.nodes.length) {
    stage.append(h('div', { className: 'graph-empty' },
      h('h3', { textContent: 'No connected evidence yet' }),
      h('p', { textContent: 'This session does not contain enough projected relationships to draw a graph.' })
    ));
    return;
  }

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'graph-svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Causal graph with ' + trace.counts.nodes + ' nodes and ' + trace.counts.edges + ' connections');

  const defs = document.createElementNS(ns, 'defs');
  defs.append(graphArrowMarker(ns, 'graphArrow', '#77777e'), graphArrowMarker(ns, 'graphArrowDanger', '#d95454'));
  svg.append(defs);
  const world = document.createElementNS(ns, 'g');
  world.setAttribute('class', 'graph-world');
  const edgeLayer = document.createElementNS(ns, 'g');
  const edgeLabelLayer = document.createElementNS(ns, 'g');
  const nodeLayer = document.createElementNS(ns, 'g');
  world.append(edgeLayer, edgeLabelLayer, nodeLayer);
  svg.append(world);
  stage.append(svg);

  const byId = {};
  trace.nodes.forEach(function(node) { byId[node.id] = node; });
  trace.edges.forEach(function(edge) {
    const from = byId[edge.from], to = byId[edge.to];
    if (!from || !to) return;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', graphEdgePath(edge, from, to));
    const danger = edge.rel === 'flagged' || edge.rel === 'sent';
    path.setAttribute('class', 'graph-edge rel-' + edge.rel + (danger ? ' danger' : ''));
    path.setAttribute('marker-end', 'url(#' + (danger ? 'graphArrowDanger' : 'graphArrow') + ')');
    path.setAttribute('data-from', edge.from);
    path.setAttribute('data-to', edge.to);
    const title = document.createElementNS(ns, 'title');
    title.textContent = from.label + ' ' + graphRelationLabel(edge.rel) + ' ' + to.label;
    path.append(title);
    edgeLayer.append(path);
    const labelPoint = graphEdgeLabelPoint(edge, from, to);
    const relation = document.createElementNS(ns, 'text');
    relation.setAttribute('class', 'graph-edge-label' + (danger ? ' danger' : ''));
    relation.setAttribute('x', String(labelPoint.x));
    relation.setAttribute('y', String(labelPoint.y - 5));
    relation.setAttribute('text-anchor', 'middle');
    relation.setAttribute('data-from', edge.from);
    relation.setAttribute('data-to', edge.to);
    relation.textContent = graphRelationLabel(edge.rel);
    edgeLabelLayer.append(relation);
  });

  trace.nodes.forEach(function(node) {
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('class', 'graph-node kind-' + node.kind + (node.risk ? ' danger' : '') + (node.id === trace.root ? ' root' : '') + (node.id === S.graphSelected ? ' selected' : ''));
    group.setAttribute('transform', 'translate(' + node.x + ',' + node.y + ')');
    group.setAttribute('data-node-id', node.id);
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'button');
    group.setAttribute('aria-label', graphKindLabel(node.kind) + ': ' + node.label + (node.sub ? ', ' + node.sub : '') + (node.risk ? ', needs review' : ''));

    const title = document.createElementNS(ns, 'title');
    title.textContent = graphKindLabel(node.kind) + ': ' + node.label + (node.sub ? ' — ' + node.sub : '');
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', '0'); rect.setAttribute('y', '0');
    rect.setAttribute('width', String(node.w)); rect.setAttribute('height', String(node.h));
    rect.setAttribute('rx', node.kind === 'file' || node.kind === 'dir' ? '5' : node.kind === 'commit' ? '18' : '11');
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('class', 'node-kind-dot');
    dot.setAttribute('cx', '16'); dot.setAttribute('cy', String(node.h / 2)); dot.setAttribute('r', '9');
    const mark = document.createElementNS(ns, 'text');
    mark.setAttribute('class', 'node-kind-mark');
    mark.setAttribute('x', '16'); mark.setAttribute('y', String(node.h / 2 + 3.5)); mark.setAttribute('text-anchor', 'middle');
    mark.textContent = graphKindMark(node.kind);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('class', 'node-label');
    label.setAttribute('x', '32');
    label.setAttribute('y', node.sub && node.h >= 46 ? String(node.h / 2 - 5) : String(node.h / 2 + 4));
    label.textContent = graphFit(node.label, node.w);
    group.append(title, rect, dot, mark, label);
    if (node.sub && node.h >= 46) {
      const sub = document.createElementNS(ns, 'text');
      sub.setAttribute('class', 'node-sub'); sub.setAttribute('x', '32'); sub.setAttribute('y', String(node.h / 2 + 10));
      sub.textContent = graphFit(node.sub, node.w);
      group.append(sub);
    }
    if (node.kind === 'dir') {
      const expand = document.createElementNS(ns, 'text');
      expand.setAttribute('class', 'node-expand'); expand.setAttribute('x', String(node.w - 15)); expand.setAttribute('y', String(node.h / 2 + 4)); expand.setAttribute('text-anchor', 'middle');
      expand.textContent = '+';
      group.append(expand);
    }
    group.addEventListener('click', function(event) { event.stopPropagation(); selectGraphNode(node.id, false, true); });
    group.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectGraphNode(node.id, true); }
    });
    nodeLayer.append(group);
  });

  graphCanvas = mountGraphCanvas(stage, svg, world, trace);
  updateGraphEmphasis();
}

function graphArrowMarker(ns, id, color) {
  const marker = document.createElementNS(ns, 'marker');
  marker.setAttribute('id', id); marker.setAttribute('viewBox', '0 0 8 8'); marker.setAttribute('refX', '7'); marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6'); marker.setAttribute('orient', 'auto');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M0 0 L8 4 L0 8 z'); path.setAttribute('fill', color);
  marker.append(path);
  return marker;
}

function graphEdgePath(edge, from, to) {
  const start = { x: from.x + from.w, y: from.y + from.h / 2 };
  const end = { x: to.x, y: to.y + to.h / 2 };
  const mids = edge.points && edge.points.length > 2 ? edge.points.slice(1, -1) : [];
  const points = mids.concat([end]);
  let d = 'M ' + graphRound(start.x) + ' ' + graphRound(start.y);
  let previous = start;
  points.forEach(function(point) {
    const middle = (previous.x + point.x) / 2;
    d += ' C ' + graphRound(middle) + ' ' + graphRound(previous.y) + ', ' + graphRound(middle) + ' ' + graphRound(point.y) + ', ' + graphRound(point.x) + ' ' + graphRound(point.y);
    previous = point;
  });
  return d;
}

function graphEdgeLabelPoint(edge, from, to) {
  const start = { x: from.x + from.w, y: from.y + from.h / 2 };
  const end = { x: to.x, y: to.y + to.h / 2 };
  const mids = edge.points && edge.points.length > 2 ? edge.points.slice(1, -1) : [];
  const points = [start].concat(mids, [end]);
  const index = Math.max(0, Math.floor((points.length - 1) / 2));
  const a = points[index], b = points[index + 1] || end;
  return { x: graphRound((a.x + b.x) / 2), y: graphRound((a.y + b.y) / 2) };
}

function graphRound(value) { return Math.round(Number(value) * 10) / 10; }

function mountGraphCanvas(stage, svg, world, trace) {
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
    world.setAttribute('transform', 'translate(' + graphRound(x) + ' ' + graphRound(y) + ') scale(' + graphRound(zoom) + ')');
    S.graphViewport = { x: x, y: y, zoom: zoom, width: stage.clientWidth || stageWidth, height: stage.clientHeight || 620 };
  }
  function fit() {
    const width = stage.clientWidth || 900;
    const height = stage.clientHeight || 620;
    zoom = Math.max(0.045, Math.min((width - 52) / Math.max(trace.width, 1), (height - 52) / Math.max(trace.height, 1), 1.25));
    x = (width - trace.width * zoom) / 2;
    y = (height - trace.height * zoom) / 2;
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
    const node = trace.nodes.find(function(item) { return item.id === id; });
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
    if (event.target.closest && event.target.closest('.graph-node')) return;
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
  let lastStageWidth = stage.clientWidth || stageWidth;
  on(window, 'resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
      const nextWidth = stage.clientWidth || lastStageWidth;
      if (Math.abs(nextWidth - lastStageWidth) < 80) return;
      lastStageWidth = nextWidth;
      if (nextWidth < 600 && (S.graphSelected || trace.root)) {
        zoom = 0.72;
        center(S.graphSelected || trace.root);
      } else fit();
    }, 120);
  });
  if (restoreSaved) apply();
  else setTimeout(function() {
    if (stage.clientWidth < 600 && (S.graphSelected || trace.root)) {
      zoom = 0.72;
      center(S.graphSelected || trace.root);
    } else fit();
  }, 0);
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

function toggleGraphFullscreen() {
  const workspace = document.querySelector('.graph-workspace');
  if (!workspace) return;
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
  else if (workspace.requestFullscreen) workspace.requestFullscreen();
}

function graphFit(value, width) {
  const max = Math.max(8, Math.floor((Number(width || 200) - 48) / 6.8));
  return clampText(value, max);
}
`;
