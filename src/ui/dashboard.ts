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
  return h('div', { className: 'privacy-command' }, h('code', { textContent: command }), h('span', { textContent: copy }));
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
    h('a', { className: 'back-link', href: '#/' }, h('span', { 'aria-hidden': 'true', textContent: '←' }), 'Dashboard'),
    h('header', { className: 'settings-hero' },
      h('div', null, h('div', { className: 'panel-label', textContent: 'Recorder controls' }), h('h1', { textContent: 'Health & privacy' }), h('p', { textContent: 'See what Blackbox stores, what can leave this computer, and how to remove local data.' })),
      h('span', { className: 'risk-badge' + (S.offline ? ' danger' : ''), textContent: S.offline ? 'Recorder offline' : 'Recorder connected' })
    )
  );
  if (!p) {
    page.append(h('section', { className: 'panel settings-loading' }));
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

/* ── dashboard ────────────────────────────────────────────────────────────── */

function verdictChip(card) {
  const verdict = String(card.verdict || 'none');
  const danger = isDanger(verdict);
  const label = danger ? verdict : verdict === 'low' ? 'low' : 'clear';
  return h('span', { className: 'chip-verdict' + (danger ? ' danger' : ''), textContent: label });
}

function sparkline(card) {
  const density = card.density || [];
  if (!density.length) return h('span', { className: 'spark', 'aria-hidden': 'true' });
  const max = Math.max.apply(null, density.concat([1]));
  const spark = h('span', { className: 'spark', 'aria-hidden': 'true' });
  const flagged = Number(card.flagged || 0) > 0;
  density.forEach(function(value, index) {
    const bar = h('i', { className: flagged && index >= density.length - 3 ? 'hot' : '' });
    bar.style.height = (4 + Math.round((value / max) * 22)) + 'px';
    spark.append(bar);
  });
  return spark;
}

function sectionHead(num, title, note, tools) {
  const head = h('div', { className: 'sec-head' },
    h('span', { className: 'sec-num', textContent: num }),
    h('h2', { textContent: title }),
    note ? h('span', { className: 'sec-note', textContent: note }) : null
  );
  if (tools) { tools.classList.add('sec-tools'); head.append(tools); }
  return head;
}

function reviewRow(card) {
  const title = sessionTitle(card, null);
  return h('button', { className: 'review-row', type: 'button', onclick: function() { setRoute(sessionHref(card.session_id, 'overview')); } },
    h('span', { className: 'review-bar', 'aria-hidden': 'true' }),
    h('span', { style: 'min-width:0' },
      h('span', { className: 'review-title', textContent: title }),
      h('span', { className: 'review-sub', textContent: basename(card.cwd) + ' · ' + (fmtSpan(card.started, card.ended) || '—') })),
    sparkline(card),
    h('span', { className: 'review-nums' },
      h('span', { className: 'ev', textContent: fmtInt(card.events) + ' events' }),
      h('span', { className: 'fl', textContent: fmtInt(card.flagged) + ' flagged' })),
    h('span', { className: 'review-rel', textContent: fmtRel(card.ended) }),
    h('span', { className: 'review-arrow', 'aria-hidden': 'true', textContent: '→' })
  );
}

function allSessionsTable() {
  const sorted = S.cards.slice();
  if (S.dashboardSort === 'risk') sorted.sort(function(a, b) { return Number(b.score || 0) - Number(a.score || 0) || Number(b.flagged || 0) - Number(a.flagged || 0) || Date.parse(b.ended || 0) - Date.parse(a.ended || 0); });
  else sorted.sort(function(a, b) { return Date.parse(b.ended || 0) - Date.parse(a.ended || 0); });
  const table = h('div', { className: 'table-card' });
  table.append(h('div', { className: 'thead' },
    h('span', { textContent: 'Session' }),
    h('span', { className: 'h-proj', textContent: 'Project' }),
    h('span', { className: 'r h-ev', textContent: 'Events' }),
    h('span', { className: 'r', textContent: 'Flags' }),
    h('span', { className: 'r', textContent: 'Risk' }),
    h('span', { className: 'r h-last', textContent: 'Last' })
  ));
  sorted.forEach(function(card) {
    table.append(h('button', { className: 'trow', type: 'button', onclick: function() { setRoute(sessionHref(card.session_id, 'overview')); } },
      h('span', { className: 't-title', textContent: sessionTitle(card, null) }),
      h('span', { className: 't-proj', textContent: basename(card.cwd) }),
      h('span', { className: 'r t-num ev-col', textContent: fmtInt(card.events) }),
      h('span', { className: 'r t-num' + (Number(card.flagged || 0) ? ' red' : ' dim'), textContent: Number(card.flagged || 0) ? fmtInt(card.flagged) : '—' }),
      verdictChip(card),
      h('span', { className: 'r t-last', textContent: fmtRel(card.ended) })
    ));
  });
  return table;
}

function renderDashboard() {
  const app = document.getElementById('app');
  if (S.route.page !== 'home') return;
  app.textContent = '';
  const q = S.query.trim();
  if (q) { renderSearchView(app, q); return; }

  const hero = h('section', { className: 'dash-hero', 'aria-labelledby': 'welcomeTitle' });
  const profileButton = h('button', { id: 'profileButton', className: 'edit-name-button', type: 'button', textContent: 'Edit name', 'aria-label': 'Edit display name', onclick: function(event) {
    event.stopPropagation();
    const pop = document.getElementById('profilePopover');
    if (pop.hidden) openProfile(); else closeProfile();
  } });
  hero.append(h('div', { className: 'dash-title-row' }, h('h1', { id: 'welcomeTitle' }, 'Welcome back, ', h('span', { textContent: S.displayName + '.' })), profileButton));
  app.append(hero);

  if (!S.cardsFp) {
    const grid = h('div', { className: 'stat-grid', 'aria-busy': 'true' });
    for (let i = 0; i < 4; i++) grid.append(h('div', { className: 'skeleton-card', style: 'height:84px' }));
    app.append(grid);
    return;
  }
  if (!S.cards.length) {
    app.append(h('section', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '□' }), h('h2', { textContent: 'No sessions recorded yet' }), h('p', { textContent: 'Start a coding session with the Blackbox hooks enabled. It will appear here automatically.' })));
    return;
  }

  const review = S.cards.filter(function(card) { return isDanger(card.verdict); })
    .sort(function(a, b) { return Date.parse(b.ended || 0) - Date.parse(a.ended || 0); });
  const projects = new Set(S.cards.map(function(card) { return basename(card.cwd); })).size;
  const tiles = h('div', { className: 'stat-grid' });
  [
    { v: fmtInt(S.cards.length), k: 'Sessions recorded', red: false },
    { v: fmtInt(review.length), k: 'Need review', red: review.length > 0 },
    { v: fmtInt(projects), k: 'Projects observed', red: false },
    { v: S.health ? fmtInt(S.health.count || 0) : '—', k: 'Events recorded', red: false }
  ].forEach(function(tile) {
    tiles.append(h('div', { className: 'stat-tile' },
      h('div', { className: 'stat-v' + (tile.red ? ' red' : ''), textContent: tile.v }),
      h('div', { className: 'stat-k', textContent: tile.k })));
  });
  app.append(tiles);

  app.append(sectionHead('01', 'Needs review', review.length ? review.length + ' session' + (review.length === 1 ? '' : 's') + ' with elevated risk' : 'no elevated risk'));
  if (review.length) {
    const list = h('div', { className: 'review-list' });
    review.forEach(function(card) { list.append(reviewRow(card)); });
    app.append(list);
  } else {
    app.append(h('div', { className: 'review-list' }, h('div', { className: 'rail-note', style: 'padding:16px 20px', textContent: 'No recorded session carries an elevated-risk verdict right now.' })));
  }

  const sort = h('div', { className: 'seg', 'aria-label': 'Sort sessions' },
    h('button', { className: S.dashboardSort === 'recent' ? 'active' : '', type: 'button', textContent: 'Recent', onclick: function() { S.dashboardSort = 'recent'; renderDashboard(); } }),
    h('button', { className: S.dashboardSort === 'risk' ? 'active' : '', type: 'button', textContent: 'Risk', onclick: function() { S.dashboardSort = 'risk'; renderDashboard(); } })
  );
  app.append(sectionHead('02', 'All sessions', null, sort));
  app.append(allSessionsTable());
}

/* ── global search ────────────────────────────────────────────────────────── */

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

function renderSearchView(app, q) {
  const view = h('section', { className: 'search-view', 'aria-label': 'Search results' });
  const sessions = localMatches();
  const hitCount = S.deepHits.length;
  view.append(
    h('div', { className: 'search-eyebrow', textContent: 'Search' }),
    h('h1', { className: 'search-q', textContent: '“' + q + '”' }),
    h('div', { className: 'search-sum', textContent: sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ' · ' + (S.searching ? 'searching evidence…' : hitCount + ' evidence hit' + (hitCount === 1 ? '' : 's')) + ' · esc to clear' })
  );
  if (sessions.length) {
    view.append(h('div', { className: 'mlabel sr-label', textContent: 'Sessions' }));
    const list = h('div', { className: 'sr-list' });
    sessions.slice(0, 10).forEach(function(card) {
      const danger = isDanger(card.verdict);
      list.append(h('button', { className: 'sr-row', type: 'button', onclick: function() { clearSearch(); setRoute(sessionHref(card.session_id, 'overview')); } },
        h('span', { style: 'min-width:0' },
          h('span', { className: 'sr-title', textContent: sessionTitle(card, null) }),
          h('span', { className: 'sr-sub', textContent: basename(card.cwd) + ' · ' + fmtRel(card.ended) + ' · ' + fmtInt(card.events) + ' events' })),
        h('span', { className: 'sr-kind' + (danger ? ' danger' : ''), textContent: danger ? card.verdict + ' risk' : 'recorded' })
      ));
    });
    view.append(list);
  }
  if (!S.searching && S.deepHits.length) {
    const bySession = new Map();
    S.deepHits.slice(0, 30).forEach(function(hit) { const list = bySession.get(hit.session_id) || []; list.push(hit); bySession.set(hit.session_id, list); });
    bySession.forEach(function(hits, sessionId) {
      const card = cardFor(sessionId);
      view.append(h('div', { className: 'mlabel sr-label', textContent: (card ? sessionTitle(card, null) : shortId(sessionId)) + ' · ' + basename(card && card.cwd) }));
      const list = h('div', { className: 'sr-list' });
      hits.slice(0, 8).forEach(function(hit) {
        const row = h('button', { className: 'sr-row hit', type: 'button', onclick: function() {
          S.pendingPromptId = hit.prompt_id || null;
          S.pendingSeq = hit.kind === 'prompt' || hit.kind === 'reasoning' ? null : (hit.seq == null ? null : hit.seq);
          clearSearch();
          setRoute(sessionHref(hit.session_id, 'activity'));
        } },
          h('span', { className: 'sr-num', textContent: hit.seq != null ? String(hit.seq) : '·' }),
          h('span', { className: 'sr-snippet' }),
          h('span', { className: 'sr-kind', textContent: hit.kind || 'evidence' }));
        renderSnippet(row.querySelector('.sr-snippet'), hit.snippet || hit.summary || hit.target || 'Recorded evidence');
        list.append(row);
      });
      view.append(list);
    });
  }
  if (!sessions.length && !S.searching && !S.deepHits.length) {
    view.append(h('section', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '⌕' }), h('h2', { textContent: 'No matches' }), h('p', { textContent: 'Try a project name, part of a prompt, a file path, or a session ID.' })));
  }
  app.append(view);
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
  if (S.route.page === 'home') renderDashboard();
}
`;
