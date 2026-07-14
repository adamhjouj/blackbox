export const SESSION_JS = String.raw`
function renderSessionPage() {
  const app = document.getElementById('app');
  app.textContent = '';
  const card = cardFor(S.route.id);
  const page = h('article', { className: 'session-page' + (S.route.tab === 'graph' ? ' graph-page' : '') });
  page.append(h('a', { className: 'back-link', href: '#/' }, h('span', { 'aria-hidden': 'true', textContent: '←' }), 'Sessions'));
  page.append(sessionHeader(card), sessionTabs());
  if (!S.story) page.append(sessionLoading());
  else if (S.route.tab === 'activity') page.append(renderActivityView());
  else if (S.route.tab === 'evidence') page.append(renderEvidenceView());
  else if (S.route.tab === 'graph') page.append(renderGraphView());
  else page.append(renderOverview());
  app.append(page);
}

function sessionHeader(card) {
  const story = S.story;
  const title = sessionTitle(card, story);
  const verdict = card && card.verdict || story && story.verdict || 'none';
  const facts = h('div', { className: 'session-facts' });
  if (card && card.cwd) facts.append(h('span', { className: 'session-project', textContent: basename(card.cwd), title: card.cwd }));
  if (card && card.started && card.ended) facts.append(h('span', { textContent: fmtSpan(card.started, card.ended) }));
  if (story) facts.append(
    h('span', null, h('strong', { textContent: story.counts.turns }), ' prompts'),
    h('span', null, h('strong', { textContent: story.counts.steps }), ' actions')
  );
  const details = h('details', { className: 'session-details' },
    h('summary', { textContent: 'Details' }),
    h('div', { className: 'session-detail-pop' },
      h('div', null, h('span', { textContent: 'Session ID' }), h('samp', { textContent: S.route.id })),
      story ? h('div', null, h('span', { textContent: 'Outcomes' }), h('samp', { textContent: story.counts.files + ' files · ' + story.counts.commits + ' commits' })) : null
    )
  );
  facts.append(details);
  return h('header', { className: 'session-hero' },
    h('div', { className: 'session-heading' }, h('h1', { textContent: title }), facts),
    h('div', { className: 'risk-badge' + (isDanger(verdict) ? ' danger' : ''), textContent: isDanger(verdict) ? cap(verdict) + ' risk' : 'No elevated risk' })
  );
}

function sessionTabs() {
  const nav = h('nav', { className: 'tabs', 'aria-label': 'Session views' });
  [
    { route: 'overview', label: 'Overview' },
    { route: 'activity', label: 'Prompts' },
    { route: 'evidence', label: 'Evidence' },
    { route: 'graph', label: 'Graph' }
  ].forEach(function(item) {
    nav.append(h('a', { className: 'tab' + (S.route.tab === item.route ? ' active' : ''), href: sessionHref(S.route.id, item.route), textContent: item.label, 'aria-current': S.route.tab === item.route ? 'page' : null }));
  });
  return nav;
}

function sessionLoading() {
  const grid = h('div', { className: 'overview-grid', 'aria-busy': 'true' });
  grid.append(h('div', { className: 'skeleton-card' }), h('div', { className: 'skeleton-card' }));
  return grid;
}

function renderSessionError() {
  const app = document.getElementById('app');
  app.textContent = '';
  app.append(h('section', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '×' }), h('h2', { textContent: 'Session could not be loaded' }), h('p', { textContent: 'The daemon returned an error. Check that it is running, then try again.' }), h('button', { className: 'secondary-button', type: 'button', textContent: 'Try again', onclick: function() { loadSessionData(S.route.id, true); } })));
}

function deterministicSummary(story, card) {
  const flagged = card && Number(card.flagged || 0) || story.turns.filter(turnFlagged).length;
  const project = basename(story.cwd || card && card.cwd);
  const outcomes = [];
  if (story.counts.files) outcomes.push('changed ' + story.counts.files + ' file' + (story.counts.files === 1 ? '' : 's'));
  if (story.counts.commits) outcomes.push('recorded ' + story.counts.commits + ' commit' + (story.counts.commits === 1 ? '' : 's'));
  let text = outcomes.length ? 'The agent ' + outcomes.join(' and ') + ' in ' + project + '.' : 'The session completed in ' + project + ' without a stored file or commit outcome.';
  text += flagged ? ' ' + flagged + ' action' + (flagged === 1 ? '' : 's') + ' require review.' : ' No elevated-risk action was detected.';
  return text;
}

function renderOverview() {
  const story = S.story, card = cardFor(S.route.id);
  const grid = h('div', { className: 'overview-grid' });
  const summary = h('section', { className: 'panel overview-outcome' },
    h('div', { className: 'panel-label', textContent: 'Outcome' }),
    h('p', { className: 'summary-copy', textContent: deterministicSummary(story, card) }),
    h('div', { className: 'overview-actions' },
      h('a', { className: 'secondary-button', href: sessionHref(S.route.id, 'activity'), textContent: 'Review prompts' }),
      h('a', { className: 'quiet-button', href: sessionHref(S.route.id, 'evidence'), textContent: 'Open evidence' })
    )
  );
  const radius = S.blast || {};
  const reach = h('section', { className: 'panel compact-panel' }, h('div', { className: 'panel-label', textContent: 'Blast radius' }));
  reach.append(
    compactFact(story.counts.files, 'changed files'),
    compactFact((radius.secrets || []).length, 'sensitive paths'),
    compactFact((radius.hosts || []).length, 'external hosts'),
    compactFact(story.counts.commits, 'git artifacts')
  );
  grid.append(summary, reach);

  const findings = overviewFindings(card, story);
  const findingPanel = h('section', { className: 'panel' }, h('div', { className: 'panel-label', textContent: 'Findings' }));
  if (findings.length) {
    const list = h('div', { className: 'finding-list' });
    findings.forEach(function(item) {
      const row = h('button', { className: 'finding-row finding-button', type: 'button', onclick: item.open },
        h('span', { className: 'severity-mark' + (item.danger ? ' danger' : '') }),
        h('span', null, h('span', { className: 'row-title', textContent: item.title }), h('span', { className: 'row-sub', textContent: item.sub })),
        item.count ? h('span', { className: 'row-count', textContent: String(item.count) }) : h('span', { className: 'row-count', textContent: 'Open →' })
      );
      list.append(row);
    });
    findingPanel.append(list);
  } else findingPanel.append(h('p', { className: 'summary-copy small', textContent: 'No elevated-risk finding was derived from the captured facts.' }));

  const actionPanel = h('section', { className: 'panel' }, h('div', { className: 'panel-label', textContent: 'Containment' }));
  const checklist = radius.checklist || [];
  if (checklist.length) {
    const list = h('div', { className: 'action-list' });
    checklist.forEach(function(item, index) {
      list.append(h('button', { className: 'action-row action-button', type: 'button', onclick: function() { if (item.seqs && item.seqs.length) openEvidence(item.seqs[0]); } },
        h('span', { className: 'row-count', textContent: String(index + 1).padStart(2, '0') }),
        h('span', null, h('span', { className: 'row-title', textContent: item.action }), h('span', { className: 'row-sub', textContent: cap(item.severity || 'review') + ' · ' + ((item.seqs || []).length || 0) + ' evidence link' + ((item.seqs || []).length === 1 ? '' : 's') })),
        h('span', { className: 'row-count', textContent: 'View →' })
      ));
    });
    actionPanel.append(list);
  } else actionPanel.append(h('p', { className: 'summary-copy small', textContent: 'No containment action is suggested by the captured facts.' }));
  grid.append(findingPanel, actionPanel);

  const coverage = story.reconciliation;
  const verified = S.verify && S.verify.ok;
  const integrityTitle = verified ? 'Hash chain verified' : S.verify ? 'Hash chain verification failed' : 'Verification unavailable';
  const coverageText = coverage ? (coverage.corroborated ? (coverage.finding_count ? coverage.finding_count + ' git discrepanc' + (coverage.finding_count === 1 ? 'y' : 'ies') + ' require review.' : 'Git ground truth corroborates the recorded mutations.') : 'Git corroboration unavailable: ' + String(coverage.coverage && coverage.coverage.reason || 'no baseline') + '.') : 'No git reconciliation was recorded.';
  grid.append(h('section', { className: 'panel wide integrity-brief' },
    h('div', null, h('div', { className: 'panel-label', textContent: 'Integrity' }), h('div', { className: 'row-title' + (!verified ? ' danger-text' : ''), textContent: integrityTitle }), h('div', { className: 'row-sub', textContent: coverageText + (S.verify && S.verify.break_reason ? ' Reason: ' + S.verify.break_reason + '.' : '') })),
    h('a', { className: 'quiet-button', href: sessionHref(S.route.id, 'evidence'), textContent: 'Inspect record →' })
  ));
  return grid;
}

function compactFact(value, label) { return h('div', { className: 'compact-fact' }, h('strong', { textContent: String(value || 0) }), h('span', { textContent: label })); }
function metric(value, label, danger) { return h('div', { className: 'metric' }, h('strong', { textContent: String(value == null ? 0 : value), className: danger ? 'danger-text' : '' }), h('span', { textContent: label })); }

function overviewFindings(card, story) {
  const out = [];
  (card && card.combos || []).forEach(function(combo, index) {
    out.push({
      danger: combo.severity === 'high' || combo.severity === 'medium',
      title: String(combo.id || 'Risk chain').replace(/-/g, ' '),
      sub: 'Events ' + String(combo.antecedent_seq || '—') + ' → ' + String(combo.consequent_seq || '—') + (combo.note ? ' · ' + clampText(combo.note, 130) : ''),
      count: null,
      open: function() { S.graphRoot = 'F:' + index; S.graphWhole = false; setRoute(sessionHref(S.route.id, 'graph')); }
    });
  });
  const flags = card && card.flags || {};
  Object.keys(flags).sort(function(a,b) { return flags[b] - flags[a]; }).forEach(function(key) {
    out.push({ danger: true, title: key.replace(/-/g, ' '), sub: 'Flagged actions in this session', count: flags[key], open: function() { S.flaggedOnly = true; setRoute(sessionHref(S.route.id, 'activity')); } });
  });
  if (!out.length && story.reconciliation && story.reconciliation.finding_count) out.push({ danger: true, title: 'Git discrepancies', sub: 'Recorded mutations differ from repository state', count: story.reconciliation.finding_count, open: function() { setRoute(sessionHref(S.route.id, 'evidence')); } });
  return out;
}

function turnFlagged(turn) { return Number(turn.flagged || 0) > 0 || Number(turn.max_score || 0) > 0 || Object.keys(turn.flags || {}).length > 0; }

function renderActivityView() {
  const wrap = h('section', { className: 'activity-view', 'aria-label': 'Session prompts' });
  const tools = new Set();
  S.story.turns.forEach(function(turn) { (turn.steps || []).forEach(function(step) { if (step.tool) tools.add(step.tool); }); });
  const search = h('input', { className: 'text-field', type: 'search', value: S.activityQuery, placeholder: 'Search prompts, explanations, tools, or paths…', autocomplete: 'off', 'aria-label': 'Search session prompts' });
  const flagged = h('button', { className: S.flaggedOnly ? 'danger-button' : 'secondary-button', type: 'button', textContent: S.flaggedOnly ? 'Flagged only' : 'All prompts', 'aria-pressed': String(S.flaggedOnly) });
  const select = h('select', { className: 'select-field', 'aria-label': 'Filter prompts by tool' }, h('option', { value: '', textContent: 'All tools' }));
  Array.from(tools).sort().forEach(function(tool) { select.append(h('option', { value: tool, textContent: tool })); });
  select.value = S.toolFilter;
  const next = h('button', { className: 'quiet-button', type: 'button', textContent: 'Next flag ↓', title: 'Next flagged prompt (N)', onclick: jumpNextFlagged });
  wrap.append(h('div', { className: 'toolbar activity-toolbar' }, flagged, search, select, next, h('span', { id: 'activityCount', className: 'toolbar-count' })), h('div', { id: 'activityList', className: 'activity-list' }));
  search.addEventListener('input', function() { S.activityQuery = search.value; S.activityCursor = -1; renderPreservingScroll(renderActivityList); });
  flagged.addEventListener('click', function() { S.flaggedOnly = !S.flaggedOnly; S.activityCursor = -1; renderPreservingScroll(renderSessionPage); });
  select.addEventListener('change', function() { S.toolFilter = select.value; S.activityCursor = -1; renderPreservingScroll(renderActivityList); });
  setTimeout(renderActivityList, 0);
  return wrap;
}

function activityTurns() {
  const q = S.activityQuery.trim().toLowerCase();
  return S.story.turns.filter(function(turn, index) {
    if (S.flaggedOnly && !turnFlagged(turn)) return false;
    if (S.toolFilter && !(turn.steps || []).some(function(step) { return step.tool === S.toolFilter; })) return false;
    if (!q) return true;
    const text = [turnDisplayTitle(turn, index), turn.prompt, turn.reasoning]
      .concat((turn.files_changed || []).map(function(file) { return file.path; }))
      .concat((turn.commits || []).map(function(commit) { return [commit.subject, commit.sha, commit.ref].join(' '); }))
      .concat((turn.steps || []).map(function(step) { return [step.tool, step.target, step.summary, (step.signals || []).join(' '), step.agent_type].join(' '); }))
      .join(' ').toLowerCase();
    return text.indexOf(q) >= 0;
  });
}

function renderActivityList() {
  const host = document.getElementById('activityList');
  if (!host) return;
  host.textContent = '';
  const turns = activityTurns();
  const count = document.getElementById('activityCount');
  if (count) count.textContent = turns.length + ' of ' + S.story.turns.length;
  if (!turns.length) { host.append(h('div', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '⌕' }), h('h2', { textContent: 'No matching prompts' }), h('p', { textContent: 'Clear a filter or search for another prompt, tool, or path.' }))); return; }
  turns.forEach(function(turn) { host.append(turnCard(turn, S.story.turns.indexOf(turn))); });
}

function turnCard(turn, index) {
  const key = turn.prompt_id || 'turn-' + index;
  const open = S.expanded.has(key);
  const flagged = turnFlagged(turn);
  const model = turn.turn_meta && turn.turn_meta.model || '';
  const meta = [(turn.steps || []).length + ' action' + ((turn.steps || []).length === 1 ? '' : 's'), fmtSpan(turn.started_at, turn.ended_at), model, tokenCount(turn)].filter(Boolean).join(' · ');
  const title = turnDisplayTitle(turn, index);
  const badges = [];
  if (turn.reasoning) badges.push('Explanation');
  if ((turn.files_changed || []).length) badges.push((turn.files_changed || []).length + ' file' + ((turn.files_changed || []).length === 1 ? '' : 's'));
  if ((turn.commits || []).length) badges.push((turn.commits || []).length + ' commit' + ((turn.commits || []).length === 1 ? '' : 's'));
  const card = h('article', { className: 'turn-card' + (flagged ? ' flagged' : ''), id: 'turn-' + (index + 1), 'data-turn-index': String(index) });
  const head = h('button', { className: 'turn-head', type: 'button', 'aria-expanded': String(open), onclick: function() { if (open) S.expanded.delete(key); else S.expanded.add(key); renderPreservingScroll(renderActivityList, 'turn-' + (index + 1)); } },
    h('span', { className: 'turn-index', textContent: (open ? '⌄ ' : '› ') + String(index + 1).padStart(2, '0') }),
    h('span', { className: 'turn-title-stack' }, h('span', { className: 'turn-gist', textContent: title, title: title }), h('span', { className: 'turn-badges', textContent: badges.join(' · ') || turnSourceLabel(turn) })),
    h('span', { className: 'turn-meta', textContent: meta + (flagged ? ' · flagged' : '') })
  );
  card.append(head);
  if (open) card.append(turnBody(turn, index));
  return card;
}

function turnBody(turn, index) {
  const body = h('div', { className: 'turn-body' });
  body.append(h('div', { className: 'turn-actions' }, h('button', { className: 'quiet-button', type: 'button', textContent: 'Trace in Graph →', onclick: function() { openTurnInGraph(turn, index); } })));
  body.append(h('section', { className: 'turn-section prompt-block' },
    h('div', { className: 'turn-section-head' }, h('span', { textContent: 'User prompt' }), h('span', { textContent: turnSourceLabel(turn) })),
    turn.prompt ? redactedTextBlock(turn.prompt, 'prompt-text') : h('p', { className: 'unavailable-copy', textContent: turn.title_source === 'subagent_action' || turn.title_source === 'subagent_activity' ? 'The host did not emit a user prompt for this subagent activity.' : 'The user prompt was not captured. The title above is derived from recorded activity.' })
  ));

  const reasonKey = (turn.prompt_id || 'turn-' + index) + ':reasoning';
  const reasonOpen = S.expanded.has(reasonKey);
  const reason = h('section', { className: 'turn-section reasoning-section' });
  const reasonToggle = h('button', { className: 'disclosure-button', type: 'button', 'aria-expanded': String(reasonOpen), onclick: function() { if (reasonOpen) S.expanded.delete(reasonKey); else S.expanded.add(reasonKey); renderPreservingScroll(renderActivityList, 'turn-' + (index + 1)); } },
    h('span', { textContent: (reasonOpen ? '⌄ ' : '› ') + 'Agent response / reasoning digest' }),
    h('span', { textContent: turn.reasoning ? 'Captured' : 'Not captured' })
  );
  reason.append(reasonToggle);
  if (reasonOpen) reason.append(turn.reasoning ? redactedTextBlock(turn.reasoning, 'reasoning') : h('p', { className: 'unavailable-copy', textContent: 'No assistant explanation was captured for this prompt.' }));
  body.append(reason);

  if ((turn.files_changed || []).length || (turn.commits || []).length) {
    const outcomes = h('section', { className: 'turn-section' }, h('div', { className: 'turn-section-head' }, h('span', { textContent: 'Outcomes' })));
    if ((turn.files_changed || []).length) outcomes.append(h('div', { className: 'outcome-list' }, (turn.files_changed || []).map(turnFileRow)));
    if ((turn.commits || []).length) outcomes.append(h('div', { className: 'outcome-list commit-list' }, (turn.commits || []).map(turnCommitRow)));
    body.append(outcomes);
  }

  const steps = h('section', { className: 'turn-section' }, h('div', { className: 'turn-section-head' }, h('span', { textContent: (turn.steps || []).length + ' recorded action' + ((turn.steps || []).length === 1 ? '' : 's') })));
  const stepList = h('div', { className: 'step-list' });
  (turn.steps || []).forEach(function(step) {
    const failed = step.success === 0;
    const danger = failed || Number(step.score || 0) > 0 || (step.signals || []).length > 0;
    const labels = [];
    if (failed) labels.push('Failed');
    if (step.is_subagent) labels.push(step.agent_type || 'Subagent');
    (step.signals || []).forEach(function(signal) { labels.push(String(signal).replace(/-/g, ' ')); });
    stepList.append(h('button', { className: 'step-row' + (danger ? ' danger' : ''), id: 'event-' + (step.post_seq || step.seq), type: 'button', onclick: function() { openEvidence(step.post_seq || step.seq); } },
      h('span', { className: 'step-time', textContent: String(step.ts || '').slice(11,19) }),
      h('span', { className: 'step-tool', textContent: step.tool || step.type || 'event' }),
      h('span', { className: 'step-content' }, h('span', { className: 'step-summary', textContent: step.summary || step.target || 'Recorded action' }), labels.length ? h('span', { className: 'step-labels', textContent: labels.join(' · ') }) : null),
      h('span', { className: 'step-duration', textContent: fmtDur(step.duration_ms) || 'View →' })
    ));
  });
  steps.append(stepList); body.append(steps);
  return body;
}

function redactedTextBlock(value, className) {
  const pre = h('pre', { className: className || '' });
  const text = String(value || '');
  const re = /\[REDACTED:[a-z0-9_-]+\]/gi;
  let cursor = 0, match;
  while ((match = re.exec(text))) {
    if (match.index > cursor) pre.append(document.createTextNode(text.slice(cursor, match.index)));
    pre.append(h('mark', { className: 'redaction-mark', textContent: match[0] }));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pre.append(document.createTextNode(text.slice(cursor)));
  return pre;
}

function turnFileRow(file) {
  const status = file.status === 'skipped' ? (file.skip_reason || 'not stored') : '+' + Number(file.insertions || 0) + ' −' + Number(file.deletions || 0);
  return h('button', { className: 'outcome-row', type: 'button', title: file.path, onclick: function() { openEvidence(file.seq); } },
    h('span', null, h('span', { className: 'outcome-title', textContent: basename(file.path) }), h('span', { className: 'outcome-sub', textContent: file.path })),
    h('span', { className: 'outcome-stat' + (file.status === 'skipped' ? ' danger-text' : ''), textContent: status })
  );
}

function turnCommitRow(commit) {
  return h('button', { className: 'outcome-row', type: 'button', title: commit.ref || '', onclick: function() { openEvidence(commit.seq); } },
    h('span', null, h('span', { className: 'outcome-title', textContent: commit.subject || commit.kind || 'Git change' }), h('span', { className: 'outcome-sub', textContent: commit.ref || commit.sha || 'Recorded git artifact' })),
    h('span', { className: 'outcome-stat', textContent: '+' + Number(commit.insertions || 0) + ' −' + Number(commit.deletions || 0) })
  );
}

function jumpNextFlagged() {
  const candidates = activityTurns().filter(turnFlagged);
  if (!candidates.length) { showToast('No flagged prompts in this view'); return; }
  S.activityCursor = (S.activityCursor + 1) % candidates.length;
  const turn = candidates[S.activityCursor];
  const index = S.story.turns.indexOf(turn);
  S.expanded.add(turn.prompt_id || 'turn-' + index);
  renderActivityList();
  setTimeout(function() { const node = document.getElementById('turn-' + (index + 1)); if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 0);
}

function navigateVisibleTurn(direction) {
  const turns = activityTurns();
  if (!turns.length) return;
  S.activityCursor = Math.max(0, Math.min(turns.length - 1, S.activityCursor + direction));
  const index = S.story.turns.indexOf(turns[S.activityCursor]);
  const node = document.getElementById('turn-' + (index + 1));
  if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function revealPendingTurn() {
  if (!S.story || !S.pendingPromptId) return;
  const promptId = S.pendingPromptId;
  S.pendingPromptId = null;
  const index = S.story.turns.findIndex(function(turn) { return turn.prompt_id === promptId; });
  if (index < 0) return;
  const turn = S.story.turns[index];
  S.expanded.add(turn.prompt_id || 'turn-' + index);
  if (S.route.tab === 'activity') renderActivityList();
  setTimeout(function() { const node = document.getElementById('turn-' + (index + 1)); if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 0);
}
`;
