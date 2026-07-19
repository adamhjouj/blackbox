export const CORE_JS = String.raw`
'use strict';
const S = {
  cards: [], cardsFp: '', fleet: null, health: null, profile: null, privacy: null, displayName: 'there',
  route: { page: 'home', id: null, tab: null, eventSeq: null }, currentId: null,
  story: null, blast: null, verify: null, sessionFp: '', loadingSession: false,
  query: '', deepHits: [], searching: false, searchTimer: null, dashboardSort: 'recent',
  expanded: new Set(), actFilter: 'all', activityCursor: -1,
  selectedSeq: null, pendingSeq: null, pendingPromptId: null,
  graph: null, graphWhole: true, graphExpand: [], graphSelected: null,
  graphFp: '', graphRequest: 0, graphViewport: null, graphPendingSeq: null, graphPendingCenter: false,
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
function fmtInt(value) { return Number(value || 0).toLocaleString('en-US'); }
function pad2(value) { return String(value).padStart(2, '0'); }

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
  return Math.floor(seconds / 3600) + 'h ' + pad2(Math.floor((seconds % 3600) / 60)) + 'm';
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
  return 'Prompt ' + (Number(index || 0) + 1) + ' · title not captured';
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

// user | agent | system — drives the turn glyph and text weight in Activity.
function turnRole(turn) {
  const source = turn && turn.title_source;
  if (source === 'captured_prompt' || source === 'recovered_prompt' || source === 'transcript_prompt') return 'user';
  if (source === 'assistant_explanation') return 'agent';
  return 'system';
}

function sessionTitle(card, story) {
  return card && card.name || story && story.name || (card && shortId(card.session_id)) || 'Untitled session';
}

function cardFor(id) { return S.cards.find(function(card) { return card.session_id === id; }) || null; }

// Which turn does an event seq belong to? Scans steps, file outcomes, and commits.
function turnIndexForSeq(seq) {
  if (!S.story || seq == null) return -1;
  const n = Number(seq);
  let found = -1;
  S.story.turns.some(function(turn, index) {
    const match = (turn.steps || []).some(function(step) { return Number(step.seq) === n || Number(step.post_seq) === n; }) ||
      (turn.files_changed || []).some(function(file) { return Number(file.seq) === n; }) ||
      (turn.commits || []).some(function(commit) { return Number(commit.seq) === n; });
    if (match) found = index;
    return match;
  });
  return found;
}

// Containment checklist review-state. Local-only, like the display name: the
// reviewer's progress never enters the forensic record.
function reviewedMap(sessionId) {
  try { return JSON.parse(localStorage.getItem('blackbox.reviewed.' + sessionId) || '{}') || {}; } catch (_) { return {}; }
}
function setReviewed(sessionId, key, done) {
  const map = reviewedMap(sessionId);
  if (done) map[key] = 1; else delete map[key];
  try { localStorage.setItem('blackbox.reviewed.' + sessionId, JSON.stringify(map)); } catch (_) {}
}

function parseRoute() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'session' && parts[1]) {
    let id = parts[1];
    try { id = decodeURIComponent(id); } catch (_) {}
    // 'evidence' stays parseable so pre-merge links keep resolving (into Activity).
    let tab = ['overview','activity','evidence','graph'].includes(parts[2]) ? parts[2] : 'overview';
    if (tab === 'evidence') tab = 'activity';
    const eventSeq = parts[3] === 'event' && /^\d+$/.test(parts[4] || '') ? Number(parts[4]) : null;
    return { page: 'session', id: id, tab: tab, eventSeq: eventSeq };
  }
  if (parts[0] === 'settings') return { page: 'settings', id: null, tab: null, eventSeq: null };
  return { page: 'home', id: null, tab: null, eventSeq: null };
}

function sessionHref(id, tab) { return '#/session/' + encodeURIComponent(id) + '/' + (tab || 'overview'); }
function evidenceHref(id, tab, seq) { return sessionHref(id, tab) + '/event/' + encodeURIComponent(String(seq)); }

function setRoute(hash) {
  if (location.hash === hash) { routeChanged(); return; }
  location.hash = hash;
}

function setWindowScroll(top) {
  const root = document.documentElement;
  const previous = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  window.scrollTo(0, Math.max(0, Number(top) || 0));
  requestAnimationFrame(function() { root.style.scrollBehavior = previous; });
}

function renderPreservingScroll(render, anchorId) {
  const before = anchorId ? document.getElementById(anchorId) : null;
  const beforeTop = before ? before.getBoundingClientRect().top : null;
  const scrollTop = window.scrollY;
  render();
  requestAnimationFrame(function() {
    const after = anchorId ? document.getElementById(anchorId) : null;
    const target = beforeTop != null && after
      ? window.scrollY + after.getBoundingClientRect().top - beforeTop
      : scrollTop;
    setWindowScroll(target);
  });
}

function routeChanged() {
  const previous = S.route;
  const next = parseRoute();
  const changedSession = next.id !== S.currentId;
  const changedView = previous.page !== next.page || previous.tab !== next.tab || previous.id !== next.id;
  const changedEvidence = previous.eventSeq !== next.eventSeq;
  S.route = next;
  sidebarActive();
  closeProfile();
  if (next.tab !== 'graph') destroyGraphCanvas();
  if (next.page === 'home') {
    closeDrawerNodes(); S.selectedSeq = null;
    renderDashboard();
    if (changedView) setWindowScroll(0);
    return;
  }
  if (next.page === 'settings') {
    closeDrawerNodes(); S.selectedSeq = null;
    renderSettingsPage();
    if (changedView) setWindowScroll(0);
    loadPrivacy();
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
    S.story = null; S.blast = null; S.sessionFp = ''; S.graph = null;
    S.graphWhole = true; S.graphExpand = []; S.graphSelected = null;
    S.graphFp = ''; S.graphViewport = null;
    S.graphPendingSeq = null; S.graphPendingCenter = false;
    S.expanded.clear(); S.actFilter = 'all'; S.activityCursor = -1;
  }
  renderSessionPage();
  if (changedView) setWindowScroll(0);
  if (next.tab === 'activity' && S.pendingPromptId && S.story) setTimeout(revealPendingTurn, 0);
  loadSessionData(next.id, changedSession);
  if (next.eventSeq != null && S.story) openEvidence(next.eventSeq, true);
}

/* ── the console rail ─────────────────────────────────────────────────────── */

function sidebarActive() {
  const dash = document.getElementById('navDash');
  if (dash) dash.classList.toggle('active', S.route.page === 'home' && !S.query.trim());
  document.querySelectorAll('.sb-item, .sb-recent').forEach(function(item) {
    item.classList.toggle('active', S.route.page === 'session' && item.getAttribute('data-id') === S.route.id);
  });
}

function sidebarSessionButton(card, review) {
  const title = sessionTitle(card, null);
  const button = h('button', { className: review ? 'sb-item' : 'sb-recent', type: 'button', title: title, onclick: function() { setRoute(sessionHref(card.session_id, 'overview')); } });
  button.setAttribute('data-id', card.session_id);
  if (review) button.append(
    h('span', { className: 'sb-bar', 'aria-hidden': 'true' }),
    h('span', null,
      h('span', { className: 'sb-item-title', textContent: title }),
      h('span', { className: 'sb-item-sub', textContent: basename(card.cwd) })),
    h('span', { className: 'sb-flag', textContent: Number(card.flagged || 0) + '⚑' })
  );
  else button.append(
    h('span', { className: 'sb-recent-title', textContent: title }),
    h('span', { className: 'sb-rel', textContent: fmtRel(card.ended) })
  );
  return button;
}

function renderSidebarLists() {
  const reviewHost = document.getElementById('sbReview');
  const recentHost = document.getElementById('sbRecent');
  if (!reviewHost || !recentHost) return;
  reviewHost.textContent = ''; recentHost.textContent = '';
  const byEnded = S.cards.slice().sort(function(a, b) { return Date.parse(b.ended || 0) - Date.parse(a.ended || 0); });
  const review = byEnded.filter(function(card) { return isDanger(card.verdict); });
  const rest = byEnded.filter(function(card) { return !isDanger(card.verdict); });
  if (review.length) {
    reviewHost.append(h('div', { className: 'sb-group-head' },
      h('span', { className: 'mlabel', textContent: 'Needs review' }),
      h('span', { className: 'sb-count', textContent: String(review.length) })));
    const list = h('div', { className: 'sb-list' });
    review.slice(0, 8).forEach(function(card) { list.append(sidebarSessionButton(card, true)); });
    reviewHost.append(list);
  }
  if (rest.length) {
    recentHost.append(h('div', { className: 'sb-group-head' }, h('span', { className: 'mlabel', textContent: 'Recent' })));
    const list = h('div', { className: 'sb-list' });
    rest.slice(0, 7).forEach(function(card) { list.append(sidebarSessionButton(card, false)); });
    recentHost.append(list);
  }
  sidebarActive();
}

function updateChrome() {
  const dot = document.getElementById('connection');
  const label = document.getElementById('connectionLabel');
  const alert = document.getElementById('connectionAlert');
  const recording = !S.offline && Date.now() < S.recordingUntil;
  if (dot) { dot.classList.toggle('offline', S.offline); dot.classList.toggle('live', recording); }
  if (label) label.textContent = S.offline ? 'Offline' : (recording ? 'Recording' : 'Connected');
  const eventCount = document.getElementById('eventCount');
  if (eventCount) eventCount.textContent = S.health ? fmtInt(S.health.count || 0) : '—';
  if (alert) {
    alert.hidden = !S.offline;
    alert.textContent = S.offline ? 'Blackbox is not responding. The last loaded session data is still available.' : '';
  }
}

async function loadProfile() {
  try { S.profile = await api('/api/profile'); } catch (_) { S.profile = { display_name: 'there' }; }
  let local = '';
  try { local = localStorage.getItem('blackbox.displayName') || ''; } catch (_) {}
  S.displayName = local.trim() || S.profile.display_name || 'there';
  updateChrome();
  if (S.route.page === 'home') renderDashboard();
}

async function loadPrivacy() {
  try {
    S.privacy = await api('/api/privacy');
    S.offline = false;
  } catch (_) { S.offline = true; }
  updateChrome();
  if (S.route.page === 'settings') renderSettingsPage();
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
  const privacy = h('button', { className: 'quiet-button profile-settings-link', type: 'button', textContent: 'Recorder & privacy →', onclick: function() { closeProfile(); setRoute('#/settings'); } });
  pop.append(title, copy, label, h('div', { className: 'popover-actions' }, cancel, save), privacy);
  pop.hidden = false;
  setTimeout(function() { input.focus(); input.select(); }, 0);
}

function closeProfile() { const pop = document.getElementById('profilePopover'); if (pop) pop.hidden = true; }

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
      renderSidebarLists();
      if (S.route.page === 'home') renderPreservingScroll(renderDashboard);
      else if (S.route.page === 'session') renderPreservingScroll(renderSessionPage);
      else if (S.route.page === 'settings') renderPreservingScroll(renderSettingsPage);
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
      api('/api/verify').catch(function() { return null; }) // re-fetch per open: badge must reflect current integrity, not a frozen read (server caches on head_seq)
    ]);
    if (S.route.id !== id) return;
    const fp = JSON.stringify([data[0], data[1], data[2]]);
    if (fp !== S.sessionFp) {
      S.story = data[0]; S.blast = data[1]; S.verify = data[2]; S.sessionFp = fp;
      renderPreservingScroll(renderSessionPage);
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
    if (S.route.page === 'settings') await loadPrivacy();
    schedulePoll();
  }, 3000);
}

function onSearchInput(value) {
  S.query = value;
  if (S.route.page !== 'home') { setRoute('#/'); } else { renderDashboard(); }
  clearTimeout(S.searchTimer);
  if (S.query.trim().length >= 2) {
    S.searching = true;
    S.searchTimer = setTimeout(runDeepSearch, 260);
  } else { S.deepHits = []; S.searching = false; }
  sidebarActive();
}

function clearSearch() {
  S.query = ''; S.deepHits = []; S.searching = false;
  const input = document.getElementById('sbSearch');
  if (input) input.value = '';
  if (S.route.page === 'home') renderDashboard();
  sidebarActive();
}

function goHomeSearch() {
  const input = document.getElementById('sbSearch');
  if (input) { input.focus(); input.select(); }
}
`;

export const BOOT_JS = String.raw`
document.addEventListener('click', function(event) {
  const pop = document.getElementById('profilePopover');
  const button = document.getElementById('profileButton');
  if (pop && !pop.hidden && !pop.contains(event.target) && (!button || !button.contains(event.target))) closeProfile();
});
document.addEventListener('keydown', function(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); goHomeSearch(); }
  if (event.key === 'Escape') {
    if (S.selectedSeq != null) closeDrawer();
    else if (S.query) clearSearch();
    else closeProfile();
  }
  if (S.route.page === 'session' && S.route.tab === 'activity' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); jumpNextFlagged(); }
      else if (event.key === ']') { event.preventDefault(); navigateVisibleTurn(1); }
      else if (event.key === '[') { event.preventDefault(); navigateVisibleTurn(-1); }
    }
  }
});
(function() {
  const input = document.getElementById('sbSearch');
  if (input) input.addEventListener('input', function() { onSearchInput(input.value); });
})();
window.addEventListener('hashchange', routeChanged);
if (!location.hash) history.replaceState(null, '', '#/');
S.route = parseRoute();
loadProfile();
refreshBase().finally(function() { routeChanged(); schedulePoll(); });
`;
