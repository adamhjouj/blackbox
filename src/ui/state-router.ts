export const CORE_JS = String.raw`
'use strict';
const S = {
  cards: [], cardsFp: '', fleet: null, health: null, profile: null, displayName: 'there',
  route: { page: 'home', id: null, tab: null, eventSeq: null }, currentId: null,
  story: null, blast: null, verify: null, sessionFp: '', loadingSession: false,
  query: '', deepHits: [], searching: false, searchTimer: null, showAll: false, dashboardSort: 'recent',
  expanded: new Set(), activityQuery: '', flaggedOnly: false, toolFilter: '', activityCursor: -1,
  evidenceQuery: '', evidenceFileLimit: 40,
  selectedSeq: null, pendingSeq: null, pendingPromptId: null, graph: null, graphRoot: null,
  graphDepth: '2', graphWhole: false, graphExpand: [], graphSelected: null,
  graphSearch: '', graphFilter: 'all', graphFp: '', graphRequest: 0,
  graphViewport: null, graphPendingSeq: null, graphPendingCenter: false,
  graphLoading: false, pollTimer: null, offline: false, lastHead: null, recordingUntil: 0
};

function h(tag, props) {
  const node = document.createElement(tag);
  if (props) Object.keys(props).forEach(function(key) {
    const value = props[key];
    if (value == null) return;
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = String(value);
    else if (key.slice(0,5) === 'aria-' || key === 'role' || key === 'title' || key === 'href' || key === 'type' || key === 'id' || key === 'placeholder' || key === 'autocomplete' || key === 'spellcheck') node.setAttribute(key, String(value));
    else if (key.slice(0,2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node[key] = value;
  });
  for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
  return node;
}

function append(node, child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) { child.forEach(function(item) { append(node, item); }); return; }
  node.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('Request failed with status ' + response.status);
  return response.json();
}

function basename(path) {
  if (!path) return 'No project';
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'No project';
}

function shortId(value) { return value ? String(value).slice(0, 12) : 'unknown'; }
function oneLine(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function cap(value) { const s = String(value || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function clampText(value, n) { const s = oneLine(value); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function isDanger(value) { return value === 'high' || value === 'medium'; }

function fmtRel(ts) {
  if (!ts) return 'Unknown time';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  if (seconds < 20) return 'Live now';
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function fmtDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return ms + 'ms';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + 's';
  return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

function fmtSpan(a, b) {
  if (!a || !b) return '';
  const seconds = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

function tokenCount(turn) {
  const usage = turn && turn.turn_meta && turn.turn_meta.usage || {};
  const count = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
  return count > 999 ? (count / 1000).toFixed(1) + 'k tok' : count ? count + ' tok' : '';
}

function turnDisplayTitle(turn, index) {
  const title = oneLine(turn && turn.display_title);
  if (title) return title;
  const prompt = oneLine(turn && turn.prompt);
  if (prompt) return prompt;
  const step = turn && turn.steps && turn.steps.find(function(item) { return item && item.summary && item.type !== 'session'; });
  if (step) return oneLine(step.summary);
  const commit = turn && turn.commits && turn.commits[0];
  if (commit) return 'Commit ' + oneLine(commit.subject || commit.sha || commit.ref || 'recorded');
  return 'Session activity ' + (Number(index || 0) + 1);
}

function turnSourceLabel(turn) {
  const source = turn && turn.title_source;
  if (source === 'captured_prompt') return 'Captured prompt';
  if (source === 'recovered_prompt' || source === 'transcript_prompt') return 'Recovered prompt';
  if (source === 'assistant_explanation') return 'Assistant response';
  if (source === 'subagent_action' || source === 'subagent_activity') return 'Subagent activity';
  if (source === 'commit') return 'Git activity';
  if (source === 'recorded_action' || source === 'activity') return 'Activity title';
  return turn && turn.prompt ? 'Captured prompt' : 'Activity title';
}

function sessionTitle(card, story) {
  return card && card.name || story && story.name || (card && shortId(card.session_id)) || 'Untitled session';
}

function cardFor(id) { return S.cards.find(function(card) { return card.session_id === id; }) || null; }

function parseRoute() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'session' && parts[1]) {
    let id = parts[1];
    try { id = decodeURIComponent(id); } catch (_) {}
    const tab = ['overview','activity','evidence','graph'].includes(parts[2]) ? parts[2] : 'overview';
    const eventSeq = parts[3] === 'event' && /^\d+$/.test(parts[4] || '') ? Number(parts[4]) : null;
    return { page: 'session', id: id, tab: tab, eventSeq: eventSeq };
  }
  return { page: 'home', id: null, tab: null, eventSeq: null };
}

function sessionHref(id, tab) { return '#/session/' + encodeURIComponent(id) + '/' + (tab || 'overview'); }
function evidenceHref(id, tab, seq) { return sessionHref(id, tab) + '/event/' + encodeURIComponent(String(seq)); }

function setRoute(hash) {
  if (location.hash === hash) { routeChanged(); return; }
  location.hash = hash;
}

function routeChanged() {
  const previous = S.route;
  const next = parseRoute();
  const changedSession = next.id !== S.currentId;
  const changedView = previous.page !== next.page || previous.tab !== next.tab || previous.id !== next.id;
  const changedEvidence = previous.eventSeq !== next.eventSeq;
  S.route = next;
  document.querySelector('.nav-home').classList.toggle('active', next.page === 'home');
  document.getElementById('app').classList.toggle('graph-shell', next.tab === 'graph');
  closeProfile();
  if (next.tab !== 'graph') destroyGraphCanvas();
  if (next.page === 'home') {
    closeDrawerNodes(); S.selectedSeq = null;
    renderDashboard();
    if (changedView) window.scrollTo(0, 0);
    return;
  }
  if (!changedView && changedEvidence) {
    if (next.eventSeq != null) openEvidence(next.eventSeq, true);
    else { S.selectedSeq = null; closeDrawerNodes(); }
    return;
  }
  if (changedSession) {
    closeDrawerNodes(); S.selectedSeq = null;
    S.currentId = next.id;
    S.story = null; S.blast = null; S.sessionFp = ''; S.graph = null; S.graphRoot = null;
    S.graphWhole = false; S.graphExpand = []; S.graphSelected = null; S.graphSearch = '';
    S.graphFilter = 'all'; S.graphFp = ''; S.graphViewport = null;
    S.graphPendingSeq = null; S.graphPendingCenter = false;
    S.expanded.clear(); S.activityQuery = ''; S.flaggedOnly = false; S.toolFilter = ''; S.activityCursor = -1;
    S.evidenceQuery = ''; S.evidenceFileLimit = 40;
  }
  renderSessionPage();
  if (changedView) window.scrollTo(0, 0);
  if (next.tab === 'activity' && S.pendingPromptId && S.story) setTimeout(revealPendingTurn, 0);
  loadSessionData(next.id, changedSession);
  if (next.eventSeq != null && S.story) openEvidence(next.eventSeq, true);
}

function updateChrome() {
  const connection = document.getElementById('connection');
  const label = document.getElementById('connectionLabel');
  const alert = document.getElementById('connectionAlert');
  connection.classList.toggle('offline', S.offline);
  label.textContent = S.offline ? 'Offline' : (Date.now() < S.recordingUntil ? 'Recording' : 'Connected');
  document.getElementById('eventCount').textContent = S.health ? String(S.health.count || 0) : '—';
  alert.hidden = !S.offline;
  alert.textContent = S.offline ? 'Blackbox is not responding. The last loaded session data is still available.' : '';
  document.getElementById('profileInitial').textContent = (S.displayName || '?').charAt(0).toUpperCase();
}

async function loadProfile() {
  try { S.profile = await api('/api/profile'); } catch (_) { S.profile = { display_name: 'there' }; }
  let local = '';
  try { local = localStorage.getItem('blackbox.displayName') || ''; } catch (_) {}
  S.displayName = local.trim() || S.profile.display_name || 'there';
  updateChrome();
  if (S.route.page === 'home') renderDashboard();
}

function openProfile() {
  const pop = document.getElementById('profilePopover');
  pop.textContent = '';
  const title = h('h2', { textContent: 'Your dashboard' });
  const copy = h('p', { textContent: 'This name stays in this browser and never enters the forensic record.' });
  const label = h('label', { className: 'field-label', textContent: 'Display name' });
  const input = h('input', { className: 'text-field', type: 'text', value: S.displayName, autocomplete: 'name', maxlength: 60 });
  label.append(input);
  const cancel = h('button', { className: 'quiet-button', type: 'button', textContent: 'Cancel', onclick: closeProfile });
  const save = h('button', { className: 'secondary-button', type: 'button', textContent: 'Save', onclick: function() {
    const value = input.value.trim().slice(0, 60) || (S.profile && S.profile.display_name) || 'there';
    S.displayName = value;
    try { localStorage.setItem('blackbox.displayName', value); } catch (_) {}
    updateChrome(); closeProfile(); if (S.route.page === 'home') renderDashboard(); showToast('Display name saved');
  }});
  pop.append(title, copy, label, h('div', { className: 'popover-actions' }, cancel, save));
  pop.hidden = false;
  setTimeout(function() { input.focus(); input.select(); }, 0);
}

function closeProfile() { document.getElementById('profilePopover').hidden = true; }

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message; toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(function() { toast.hidden = true; }, 2200);
}

async function refreshBase() {
  let health = null, cards = null, fleet = null;
  try {
    const data = await Promise.all([api('/health'), api('/api/sessions'), api('/api/fleet').catch(function() { return null; })]);
    health = data[0]; cards = data[1]; fleet = data[2]; S.offline = false;
  } catch (_) { S.offline = true; }
  if (health) S.health = health;
  if (health && S.lastHead != null && Number(health.head_seq || 0) > S.lastHead) S.recordingUntil = Date.now() + 6500;
  if (health) S.lastHead = Number(health.head_seq || 0);
  if (fleet) S.fleet = fleet;
  updateChrome();
  if (cards) {
    const fp = JSON.stringify(cards);
    if (fp !== S.cardsFp) {
      S.cardsFp = fp; S.cards = cards;
      if (S.route.page === 'home') renderDashboard();
      else renderSessionPage();
    }
  }
}

async function loadSessionData(id, initial) {
  if (!id || S.loadingSession) return;
  S.loadingSession = true;
  if (initial) renderSessionPage();
  try {
    const data = await Promise.all([
      api('/api/session/' + encodeURIComponent(id) + '/story'),
      api('/api/session/' + encodeURIComponent(id) + '/blast').catch(function() { return null; }),
      S.verify || api('/api/verify').catch(function() { return null; })
    ]);
    if (S.route.id !== id) return;
    const fp = JSON.stringify([data[0], data[1], data[2]]);
    if (fp !== S.sessionFp) {
      const y = window.scrollY;
      S.story = data[0]; S.blast = data[1]; S.verify = data[2]; S.sessionFp = fp;
      renderSessionPage();
      requestAnimationFrame(function() { window.scrollTo(0, y); });
      if (S.pendingPromptId) setTimeout(revealPendingTurn, 0);
      if (S.pendingSeq != null) { const seq = S.pendingSeq; S.pendingSeq = null; openEvidence(seq); }
      else if (S.route.eventSeq != null) openEvidence(S.route.eventSeq, true);
    }
  } catch (_) {
    if (S.route.id === id) renderSessionError();
  } finally { S.loadingSession = false; }
}

function schedulePoll() {
  clearTimeout(S.pollTimer);
  S.pollTimer = setTimeout(async function tick() {
    await refreshBase();
    if (S.route.page === 'session' && S.route.id) {
      await loadSessionData(S.route.id, false);
      if (S.route.tab === 'graph') await loadGraph(false);
    }
    schedulePoll();
  }, 3000);
}

function goHomeSearch() {
  if (S.route.page !== 'home') setRoute('#/');
  setTimeout(function() { const input = document.getElementById('homeSearch'); if (input) input.focus(); }, 30);
}
`;

export const BOOT_JS = String.raw`
document.getElementById('globalSearch').addEventListener('click', goHomeSearch);
document.getElementById('profileButton').addEventListener('click', function(event) {
  event.stopPropagation();
  const pop = document.getElementById('profilePopover');
  if (pop.hidden) openProfile(); else closeProfile();
});
document.addEventListener('click', function(event) {
  const pop = document.getElementById('profilePopover');
  if (!pop.hidden && !pop.contains(event.target) && !document.getElementById('profileButton').contains(event.target)) closeProfile();
});
document.addEventListener('keydown', function(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); goHomeSearch(); }
  if (event.key === 'Escape') { if (S.selectedSeq != null) closeDrawer(); else closeProfile(); }
  if (S.route.page === 'session' && S.route.tab === 'activity' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); jumpNextFlagged(); }
      else if (event.key === ']') { event.preventDefault(); navigateVisibleTurn(1); }
      else if (event.key === '[') { event.preventDefault(); navigateVisibleTurn(-1); }
    }
  }
});
window.addEventListener('hashchange', routeChanged);
if (!location.hash) history.replaceState(null, '', '#/');
S.route = parseRoute();
loadProfile();
refreshBase().finally(function() { routeChanged(); schedulePoll(); });
`;
