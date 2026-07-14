export const DASHBOARD_JS = String.raw`
function formatStorage(bytes) {
  let value = Number(bytes || 0);
  if (value < 1024) return value + ' B';
  const units = ['KB','MB','GB','TB'];
  let unit = units[0]; value /= 1024;
  for (let i = 1; value >= 1024 && i < units.length; i++) { value /= 1024; unit = units[i]; }
  return value.toFixed(value >= 10 ? 1 : 2) + ' ' + unit;
}

function settingsFact(label, value, mono) {
  return h('div', { className: 'settings-fact' },
    h('span', { textContent: label }),
    h(mono ? 'samp' : 'strong', { textContent: value || '—' })
  );
}

function commandRow(command, copy) {
  const row = h('div', { className: 'privacy-command' }, h('code', { textContent: command }), h('span', { textContent: copy }));
  return row;
}

function renderSettingsPage() {
  const app = document.getElementById('app');
  app.textContent = '';
  const p = S.privacy;
  const anchor = p && p.anchor || {};
  const anchorState = anchor.kind === 'none'
    ? 'Not configured'
    : anchor.external
      ? cap(anchor.kind) + (anchor.auto_push ? ' · automatic receipts' : ' · external receipts')
      : 'Local-only · reduced custody';
  const page = h('article', { className: 'settings-page' });
  page.append(
    h('a', { className: 'back-link', href: '#/' }, h('span', { 'aria-hidden': 'true', textContent: '←' }), 'Sessions'),
    h('header', { className: 'settings-hero' },
      h('div', null, h('div', { className: 'panel-label', textContent: 'Recorder controls' }), h('h1', { textContent: 'Health & privacy' }), h('p', { textContent: 'See what Blackbox stores, what can leave this computer, and how to remove local data.' })),
      h('span', { className: 'risk-badge' + (S.offline ? ' danger' : ''), textContent: S.offline ? 'Recorder offline' : 'Recorder connected' })
    )
  );
  if (!p) {
    page.append(h('section', { className: 'panel settings-loading' }, h('div', { className: 'skeleton-line wide' }), h('div', { className: 'skeleton-line' })));
    app.append(page); return;
  }
  const recorder = h('section', { className: 'panel settings-panel' },
    h('div', { className: 'panel-label', textContent: 'Recorder' }),
    h('h2', { textContent: 'Local service' }),
    settingsFact('Endpoint', p.bind, true),
    settingsFact('Recorded events', String(S.health && S.health.count || 0), false),
    settingsFact('Stored data', formatStorage(p.storage_bytes), false),
    settingsFact('Retention', p.retention === 'manual' ? 'Manual · nothing expires silently' : String(p.retention), false)
  );
  const storage = h('section', { className: 'panel settings-panel' },
    h('div', { className: 'panel-label', textContent: 'Local storage' }),
    h('h2', { textContent: 'Evidence stays here' }),
    settingsFact('Database', p.db, true),
    settingsFact('State directory', p.data_dir, true),
    settingsFact('Tool output bodies', p.capture_output_bodies ? 'Stored after redaction' : 'Elided to hashes by default', false)
  );
  const custody = h('section', { className: 'panel settings-panel' },
    h('div', { className: 'panel-label', textContent: 'Custody' }),
    h('h2', { textContent: anchorState }),
    settingsFact('Destination', anchor.destination || 'None', true),
    h('p', { className: 'settings-copy', textContent: anchor.external
      ? 'Only signed chain-head receipts can leave this machine. They contain no prompts, paths, code, commands, or tool output.'
      : 'No independent off-machine witness is active. A full-write attacker could replace the local database, key, watermark, and receipts together.' })
  );
  const captured = h('section', { className: 'panel settings-panel' },
    h('div', { className: 'panel-label', textContent: 'Captured locally' }),
    h('h2', { textContent: 'Reviewable agent activity' }),
    h('ul', { className: 'privacy-list' },
      h('li', { textContent: 'Prompts and agent-stated reasoning, when available' }),
      h('li', { textContent: 'Tool and MCP inputs, file mutations, paths, and Git facts' }),
      h('li', { textContent: 'Model, token, duration, redaction, and risk metadata' })
    )
  );
  const controls = h('section', { className: 'panel settings-panel settings-wide' },
    h('div', { className: 'panel-label', textContent: 'Data controls' }),
    h('h2', { textContent: 'Nothing is deleted silently' }),
    h('p', { className: 'settings-copy', textContent: 'Run these commands in Terminal. Session facts share one append-only chain, so content can be aged out independently while complete deletion is intentionally store-wide.' }),
    h('div', { className: 'privacy-commands' },
      commandRow('blackbox prune --older-than 30d', 'Age out old mutation bodies; retain hashes and facts'),
      commandRow('blackbox erase --all --yes', 'Delete the complete local store, keys, logs, and local receipts'),
      commandRow('blackbox uninit --erase-data --yes', 'Remove hooks, stop recording, and delete all local data')
    )
  );
  page.append(h('div', { className: 'settings-grid' }, recorder, storage, custody, captured, controls));
  app.append(page);
}

function renderDashboard() {
  const app = document.getElementById('app');
  app.textContent = '';
  const hero = h('section', { className: 'hero', 'aria-labelledby': 'welcomeTitle' });
  const profileButton = h('button', { id: 'profileButton', className: 'edit-name-button', type: 'button', textContent: 'Edit name', 'aria-label': 'Edit display name', onclick: function(event) {
    event.stopPropagation();
    const pop = document.getElementById('profilePopover');
    if (pop.hidden) openProfile(); else closeProfile();
  } });
  hero.append(h('div', { className: 'hero-title-row' }, h('h1', { id: 'welcomeTitle' }, 'Welcome back, ', h('span', { textContent: S.displayName + '.' })), profileButton), h('p', { className: 'dashboard-status', textContent: dashboardIntro() }));
  const searchWrap = h('div', { className: 'search-wrap' });
  const input = h('input', {
    id: 'homeSearch', className: 'home-search', type: 'search', value: S.query,
    placeholder: 'Search sessions, projects, prompts, or evidence…', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Search sessions and evidence'
  });
  input.addEventListener('input', function() {
    S.query = input.value;
    renderHomeResults();
    clearTimeout(S.searchTimer);
    if (S.query.trim().length >= 2) {
      S.searching = true;
      S.searchTimer = setTimeout(runDeepSearch, 260);
    } else { S.deepHits = []; S.searching = false; }
  });
  searchWrap.append(h('span', { className: 'search-icon', 'aria-hidden': 'true', textContent: '⌕' }), input);
  if (S.query) searchWrap.append(h('button', { className: 'search-clear', type: 'button', 'aria-label': 'Clear search', textContent: '×', onclick: function() { S.query = ''; S.deepHits = []; S.searching = false; renderDashboard(); setTimeout(function() { document.getElementById('homeSearch').focus(); }, 0); } }));
  hero.append(searchWrap);
  app.append(hero, h('div', { id: 'homeResults' }));
  renderHomeResults();
}

function dashboardIntro() {
  const count = S.cards.length;
  if (S.offline) return 'Recorder offline · showing the last loaded sessions';
  if (!count) return 'Blackbox is ready. Your recorded coding sessions will appear here automatically.';
  const risky = S.cards.filter(function(card) { return isDanger(card.verdict); }).length;
  return count + ' recorded session' + (count === 1 ? '' : 's') + (risky ? ' · ' + risky + ' need review' : ' · no elevated risk');
}

function localMatches() {
  const q = S.query.trim().toLowerCase();
  if (!q) return S.cards.slice();
  return S.cards.map(function(card) {
    const title = sessionTitle(card, null).toLowerCase();
    const project = basename(card.cwd).toLowerCase();
    const id = String(card.session_id || '').toLowerCase();
    let rank = 0;
    if (title === q) rank = 100;
    else if (title.indexOf(q) === 0) rank = 80;
    else if (title.indexOf(q) >= 0) rank = 60;
    else if (project.indexOf(q) === 0) rank = 45;
    else if (project.indexOf(q) >= 0) rank = 35;
    else if (id.indexOf(q) >= 0) rank = 20;
    return { card: card, rank: rank };
  }).filter(function(item) { return item.rank > 0; }).sort(function(a, b) { return b.rank - a.rank || Date.parse(b.card.ended || 0) - Date.parse(a.card.ended || 0); }).map(function(item) { return item.card; });
}

function renderHomeResults() {
  const host = document.getElementById('homeResults');
  if (!host) return;
  host.textContent = '';
  const q = S.query.trim();
  if (q) { renderSearchResults(host, localMatches()); return; }
  if (!S.cardsFp) { renderDashboardSkeleton(host); return; }
  if (!S.cards.length) { host.append(dashboardEmpty()); return; }

  const block = h('section', { className: 'section-block', 'aria-labelledby': 'recentTitle' });
  const actions = h('div', { className: 'section-actions' });
  const left = h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Scroll sessions left', textContent: '←' });
  const right = h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Scroll sessions right', textContent: '→' });
  const view = h('button', { className: 'quiet-button', type: 'button', textContent: S.showAll ? 'Show shelf' : 'View all', onclick: function() { S.showAll = !S.showAll; renderHomeResults(); } });
  if (S.showAll) actions.append(h('div', { className: 'sort-switch', 'aria-label': 'Sort sessions' },
    h('button', { className: S.dashboardSort === 'recent' ? 'active' : '', type: 'button', textContent: 'Recent', onclick: function() { S.dashboardSort = 'recent'; renderHomeResults(); } }),
    h('button', { className: S.dashboardSort === 'risk' ? 'active' : '', type: 'button', textContent: 'Risk', onclick: function() { S.dashboardSort = 'risk'; renderHomeResults(); } })
  ));
  actions.append(left, right, view);
  block.append(h('div', { className: 'section-head' }, h('h2', { id: 'recentTitle', textContent: S.showAll ? 'All sessions' : 'Recent sessions' }), actions));
  const recent = S.cards.slice().sort(function(a, b) { return Date.parse(b.ended || 0) - Date.parse(a.ended || 0); });
  const risk = S.cards.slice().sort(function(a, b) { return Number(b.score || 0) - Number(a.score || 0) || Date.parse(b.ended || 0) - Date.parse(a.ended || 0); });
  const cards = S.showAll ? (S.dashboardSort === 'risk' ? risk : recent) : recent.slice(0, 12);
  const list = h('div', { id: 'sessionShelf', className: S.showAll ? 'session-grid' : 'session-shelf' });
  cards.forEach(function(card) { list.append(sessionCard(card)); });
  block.append(list); host.append(block);
  left.disabled = S.showAll; right.disabled = S.showAll;
  left.addEventListener('click', function() { list.scrollBy({ left: -560, behavior: 'smooth' }); });
  right.addEventListener('click', function() { list.scrollBy({ left: 560, behavior: 'smooth' }); });
  list.addEventListener('keydown', function(event) {
    if (S.showAll || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    const links = Array.from(list.querySelectorAll('.session-card'));
    const index = links.indexOf(document.activeElement);
    if (index < 0) return;
    const nextIndex = Math.max(0, Math.min(links.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
    if (nextIndex === index) return;
    event.preventDefault(); links[nextIndex].focus(); links[nextIndex].scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  });
}

function sessionCard(card) {
  const danger = isDanger(card.verdict);
  const title = sessionTitle(card, null);
  const link = h('a', { className: 'session-card' + (danger ? ' risk' : ''), href: sessionHref(card.session_id, 'overview'), 'aria-label': 'Open session ' + title });
  const state = danger ? cap(card.verdict) + ' risk' : (fmtRel(card.ended) === 'Live now' ? 'Live now' : 'Recorded');
  const stateEl = h('span', { className: 'card-state' + (danger ? ' danger' : ''), textContent: state });
  const flagged = Number(card.flagged || 0);
  const findings = Array.isArray(card.combos) ? card.combos.length : 0;
  const reviewCount = flagged
    ? flagged + ' flagged'
    : findings
      ? findings + ' finding' + (findings === 1 ? '' : 's')
      : 'no flags';
  link.append(
    h('div', { className: 'card-top' }, h('span', { className: 'card-project', textContent: basename(card.cwd) }), stateEl),
    h('h3', { textContent: title }),
    h('div', { className: 'card-footer' },
      h('div', { className: 'card-stats' }, h('strong', { textContent: fmtRel(card.ended) }), String(card.events || 0) + ' events · ' + reviewCount),
      h('span', { className: 'card-arrow', 'aria-hidden': 'true', textContent: '↗' })
    )
  );
  return link;
}

function renderSearchResults(host, sessions) {
  const groups = h('section', { className: 'search-groups', 'aria-label': 'Search results' });
  const sessionGroup = h('div', { className: 'result-group' }, h('div', { className: 'result-label', textContent: sessions.length + ' session' + (sessions.length === 1 ? '' : 's') }));
  sessions.slice(0, 10).forEach(function(card) {
    const title = sessionTitle(card, null);
    sessionGroup.append(h('a', { className: 'result-row', href: sessionHref(card.session_id, 'overview') },
      h('span', null, h('div', { className: 'result-title', textContent: title }), h('div', { className: 'result-sub', textContent: basename(card.cwd) + ' · ' + fmtRel(card.ended) + ' · ' + String(card.events || 0) + ' events' })),
      h('span', { className: 'result-kind', textContent: isDanger(card.verdict) ? card.verdict + ' risk' : 'session' })
    ));
  });
  groups.append(sessionGroup);
  if (S.searching) groups.append(h('div', { className: 'result-group' }, h('div', { className: 'result-label', textContent: 'Searching recorded evidence…' })));
  else if (S.deepHits.length) {
    const bySession = new Map();
    S.deepHits.slice(0, 30).forEach(function(hit) { const list = bySession.get(hit.session_id) || []; list.push(hit); bySession.set(hit.session_id, list); });
    bySession.forEach(function(hits, sessionId) {
      const card = cardFor(sessionId);
      const evidence = h('div', { className: 'result-group' }, h('div', { className: 'result-label', textContent: (card ? sessionTitle(card, null) : shortId(sessionId)) + ' · ' + basename(card && card.cwd) }));
      hits.slice(0, 8).forEach(function(hit) {
        const link = h('a', { className: 'result-row', href: sessionHref(hit.session_id, 'activity'), onclick: function(event) {
          event.preventDefault();
          S.pendingPromptId = hit.prompt_id || null;
          S.pendingSeq = hit.kind === 'prompt' || hit.kind === 'reasoning' ? null : (hit.seq == null ? null : hit.seq);
          setRoute(sessionHref(hit.session_id, 'activity'));
        } }, h('span', null, h('span', { className: 'result-title snippet-title' }), h('span', { className: 'result-sub', textContent: hit.prompt_id ? 'Open matching prompt' : 'Open recorded event' })), h('span', { className: 'result-kind', textContent: hit.kind || 'evidence' }));
        renderSnippet(link.querySelector('.snippet-title'), hit.snippet || hit.summary || hit.target || 'Recorded evidence');
        evidence.append(link);
      });
      groups.append(evidence);
    });
  }
  if (!sessions.length && !S.searching && !S.deepHits.length) groups.append(h('div', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '⌕' }), h('h2', { textContent: 'No matching sessions' }), h('p', { textContent: 'Try a project name, part of a prompt, a file path, or a session ID.' })));
  host.append(groups);
}

function renderSnippet(node, value) {
  const text = String(value || '');
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('[', cursor);
    if (start < 0) { node.append(document.createTextNode(text.slice(cursor))); break; }
    if (start > cursor) node.append(document.createTextNode(text.slice(cursor, start)));
    const end = text.indexOf(']', start + 1);
    if (end < 0) { node.append(document.createTextNode(text.slice(start))); break; }
    node.append(h('mark', { textContent: text.slice(start + 1, end) }));
    cursor = end + 1;
  }
}

async function runDeepSearch() {
  const query = S.query.trim();
  if (query.length < 2) return;
  try {
    const result = await api('/api/search?q=' + encodeURIComponent(query));
    if (S.query.trim() !== query) return;
    S.deepHits = result.hits || [];
  } catch (_) { S.deepHits = []; }
  S.searching = false;
  renderHomeResults();
}

function renderDashboardSkeleton(host) {
  const block = h('section', { className: 'section-block' });
  block.append(h('div', { className: 'section-head' }, h('div', null, h('h2', { textContent: 'Loading sessions' }), h('p', { textContent: 'Reading the local forensic store.' }))));
  const row = h('div', { className: 'session-shelf', 'aria-busy': 'true' });
  for (let i = 0; i < 4; i++) row.append(h('div', { className: 'skeleton-card' }));
  block.append(row); host.append(block);
}

function dashboardEmpty() {
  return h('section', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '□' }), h('h2', { textContent: 'No sessions recorded yet' }), h('p', { textContent: 'Start a coding session with the Blackbox hooks enabled. It will appear here automatically.' }));
}
`;
