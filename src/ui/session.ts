export const SESSION_JS = String.raw`
function renderSessionPage() {
  const app = document.getElementById('app');
  app.textContent = '';
  const card = cardFor(S.route.id);
  const page = h('article', { className: 'session-page' });
  page.append(h('a', { className: 'back-link', href: '#/' }, h('span', { 'aria-hidden': 'true', textContent: '←' }), 'Dashboard'));
  page.append(sessionHeader(card), sessionTabs());
  if (!S.story) page.append(sessionLoading());
  else if (S.route.tab === 'activity') page.append(renderActivityView());
  else if (S.route.tab === 'graph') page.append(renderGraphView());
  else page.append(renderOverview());
  app.append(page);
}

function sessionHeader(card) {
  const story = S.story;
  const title = sessionTitle(card, story);
  const verdict = card && card.verdict || story && story.verdict || 'none';
  const facts = h('div', { className: 'session-facts' });
  if (card && card.started && card.ended) facts.append(h('span', { textContent: fmtSpan(card.started, card.ended) }));
  if (story) facts.append(
    h('span', null, h('strong', { textContent: fmtInt(story.counts.turns) }), ' prompt' + (story.counts.turns === 1 ? '' : 's')),
    h('span', null, h('strong', { textContent: fmtInt(story.counts.steps) }), ' action' + (story.counts.steps === 1 ? '' : 's'))
  );
  if (card) facts.append(h('span', null, h('strong', { textContent: fmtInt(card.events) }), ' event' + (card.events === 1 ? '' : 's')));
  facts.append(h('span', { className: 'session-id-inline', textContent: S.route.id }));
  return h('header', { className: 'session-hero' },
    h('div', { style: 'min-width:0' },
      h('div', { className: 'session-crumb', textContent: basename(card && card.cwd || story && story.cwd) + ' /' }),
      h('h1', { textContent: title }),
      facts),
    h('div', { className: 'risk-badge' + (isDanger(verdict) ? ' danger' : ''), textContent: isDanger(verdict) ? cap(verdict) + ' risk' : 'No elevated risk' })
  );
}

function sessionTabs() {
  const nav = h('nav', { className: 'tabs', 'aria-label': 'Session views' });
  [
    { route: 'overview', label: 'Overview' },
    { route: 'activity', label: S.story ? 'Activity · ' + S.story.counts.turns : 'Activity' },
    { route: 'graph', label: 'Graph' }
  ].forEach(function(item) {
    nav.append(h('a', { className: 'tab' + (S.route.tab === item.route ? ' active' : ''), href: sessionHref(S.route.id, item.route), textContent: item.label, 'aria-current': S.route.tab === item.route ? 'page' : null }));
  });
  return nav;
}

function sessionLoading() {
  const stack = h('div', { className: 'ov-stack', 'aria-busy': 'true' });
  stack.append(h('div', { className: 'skeleton-card' }), h('div', { className: 'skeleton-card' }));
  return stack;
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

function numLabel(num, text) {
  return h('div', { className: 'mlabel' }, h('span', { className: 'num', textContent: num + ' · ' }), text);
}

/* ── overview: 01 what happened → 04 can you trust this record ────────────── */

function renderOverview() {
  const story = S.story, card = cardFor(S.route.id);
  const radius = S.blast || {};
  const stack = h('div', { className: 'ov-stack' });

  // 01 · WHAT HAPPENED — the outcome sentence and the blast-radius strip.
  const hero = h('section', { className: 'panel' });
  hero.append(h('div', { className: 'ov-hero-top' },
    h('div', { style: 'min-width:0' },
      numLabel('01', 'What happened'),
      h('p', { className: 'ov-outcome', textContent: deterministicSummary(story, card) })),
    h('div', { className: 'ov-cta' },
      h('a', { className: 'secondary-button', href: sessionHref(S.route.id, 'activity'), textContent: 'Review activity', style: 'display:inline-flex;align-items:center' }),
      h('a', { className: 'quiet-button', href: sessionHref(S.route.id, 'graph'), textContent: 'Open graph', style: 'display:inline-flex;align-items:center' }))
  ));
  const strip = h('div', { className: 'blast-strip' });
  [
    { v: story.counts.files, k: 'changed files' },
    { v: (radius.secrets || []).length, k: 'sensitive paths' },
    { v: (radius.hosts || []).length, k: 'external hosts' },
    { v: story.counts.commits, k: 'git artifacts' }
  ].forEach(function(cell) {
    strip.append(h('div', { className: 'blast-cell' },
      h('span', { className: 'blast-v' + (Number(cell.v) ? '' : ' zero'), textContent: String(cell.v || 0) }),
      h('span', { className: 'blast-k', textContent: cell.k })));
  });
  hero.append(strip);
  stack.append(hero);

  const cols = h('div', { className: 'ov-cols' });

  // 02 · WHAT NEEDS ATTENTION — findings derived from the captured facts.
  const findings = overviewFindings(card, story);
  const findPanel = h('section', { className: 'panel panel-pad' });
  findPanel.append(h('div', { className: 'head-row' }, numLabel('02', 'What needs attention'),
    h('span', { className: 'note', textContent: findings.length ? findings.length + ' derived from captured facts' : '' })));
  if (findings.length) {
    const list = h('div', { className: 'find-list' });
    findings.forEach(function(item, index) {
      list.append(h('button', { className: 'find-row', type: 'button', onclick: item.open },
        h('span', { className: 'find-num', textContent: pad2(index + 1) }),
        h('span', { className: 'find-dot', 'aria-hidden': 'true' }),
        h('span', { style: 'min-width:0' },
          h('span', { className: 'find-title', textContent: item.title }),
          h('span', { className: 'find-sub', textContent: item.sub })),
        h('span', { className: 'find-count', textContent: item.count ? item.count + ' action' + (item.count === 1 ? '' : 's') : 'Open →' })));
    });
    findPanel.append(list);
  } else findPanel.append(h('p', { className: 'summary-copy small', style: 'margin-top:8px', textContent: 'No elevated-risk finding was derived from the captured facts.' }));

  // 03 · HOW TO RESPOND — the containment checklist, checkable and persistent.
  const checklist = radius.checklist || [];
  const reviewed = reviewedMap(S.route.id);
  const done = checklist.filter(function(item) { return reviewed[String(item.order)]; }).length;
  const respondPanel = h('section', { className: 'panel panel-pad' });
  respondPanel.append(h('div', { className: 'head-row' }, numLabel('03', 'How to respond'),
    h('span', { className: 'note end', textContent: checklist.length ? done + ' of ' + checklist.length + ' reviewed' : '' })));
  if (checklist.length) {
    const bar = h('div', { className: 'progress' }, h('i'));
    bar.firstChild.style.width = Math.round((done / checklist.length) * 100) + '%';
    respondPanel.append(bar);
    const list = h('div', { className: 'chk-list' });
    checklist.forEach(function(item) {
      const key = String(item.order);
      const isDone = !!reviewed[key];
      const row = h('div', { className: 'chk-row' + (isDone ? ' done' : '') });
      row.append(
        h('button', { className: 'chk-box', type: 'button', 'aria-label': 'Mark step reviewed', 'aria-pressed': String(isDone), textContent: isDone ? '✓' : '', onclick: function() {
          setReviewed(S.route.id, key, !isDone);
          renderPreservingScroll(renderSessionPage);
        } }),
        h('button', { className: 'chk-body', type: 'button', onclick: function() { if (item.seqs && item.seqs.length) openEvidence(item.seqs[0]); } },
          h('span', { style: 'min-width:0' },
            h('span', { className: 'chk-title', textContent: item.action }),
            h('span', { className: 'chk-sub', textContent: cap(item.severity || 'review') + ' · ' + ((item.seqs || []).length || 0) + ' evidence link' + ((item.seqs || []).length === 1 ? '' : 's') })),
          h('span', { className: 'chk-view', textContent: 'View →' }))
      );
      list.append(row);
    });
    respondPanel.append(list);
  } else respondPanel.append(h('p', { className: 'summary-copy small', style: 'margin-top:8px', textContent: 'No containment step is suggested by the captured facts.' }));
  cols.append(findPanel, respondPanel);
  stack.append(cols);

  // 04 · CAN YOU TRUST THIS RECORD — one slim integrity strip.
  const verify = S.verify;
  const recon = story.reconciliation;
  const completeness = recon && recon.coverage && recon.coverage.completeness;
  const trust = h('section', { className: 'panel' });
  const stripRow = h('div', { className: 'trust-strip' });
  stripRow.append(numLabel('04', 'Can you trust this record'));
  [
    { v: verify ? (verify.ok ? 'Verified' : 'Failed') : 'Unknown', k: 'hash chain', bad: verify && !verify.ok },
    { v: verify && verify.signed ? 'Signed' : 'Unsigned', k: 'checkpoint', bad: false },
    { v: verify && verify.head_seq != null ? fmtInt(verify.head_seq) : '—', k: 'chain head', bad: false },
    { v: String(recon && recon.finding_count || 0), k: 'git discrepancies', bad: recon && recon.finding_count > 0 }
  ].forEach(function(pair) {
    stripRow.append(h('span', { className: 'trust-pair' },
      h('span', { className: 'trust-v' + (pair.bad ? ' bad' : ''), textContent: pair.v }),
      h('span', { className: 'trust-k', textContent: pair.k })));
  });
  if (completeness) {
    const pct = Math.round(Number(completeness.coverage_ratio || 0) * 100);
    const wrap = h('span', { className: 'capture-wrap' },
      h('span', { className: 'capture-label', textContent: 'capture ' + pct + '%' }),
      h('span', { className: 'capture-bar' }, h('i')));
    wrap.querySelector('i').style.width = pct + '%';
    stripRow.append(wrap);
  }
  const notes = [];
  if (verify && verify.latest_sig_seq != null) notes.push('Latest signature at sequence ' + verify.latest_sig_seq + (verify.latest_sig_ts ? ' · ' + verify.latest_sig_ts : ''));
  if (verify && !verify.ok && verify.break_reason) notes.push('Verification failed: ' + verify.break_reason);
  if (recon) notes.push(recon.corroborated
    ? (recon.finding_count ? recon.finding_count + ' git discrepanc' + (recon.finding_count === 1 ? 'y requires' : 'ies require') + ' review' : 'Git ground truth corroborates the recorded mutations')
    : 'Git reconciliation unavailable — uncorroborated: ' + String(recon.coverage && recon.coverage.reason || 'no baseline'));
  else notes.push('No git reconciliation was recorded');
  if (completeness) notes.push(completeness.recorded + ' of ' + completeness.transcript_tool_uses + ' tool calls recorded');
  stripRow.append(h('span', { className: 'trust-note', textContent: notes.join(' · ') + '.' }));
  trust.append(stripRow);
  if (recon && (recon.findings || []).length) {
    const details = h('details', { className: 'trust-findings' }, h('summary', { textContent: 'Show all reconciliation findings' }));
    const list = h('div', { className: 'find-list' });
    (recon.findings || []).forEach(function(finding, index) {
      list.append(h('button', { className: 'find-row', type: 'button', onclick: function() { if (finding.seq != null) openEvidence(finding.seq); } },
        h('span', { className: 'find-num', textContent: pad2(index + 1) }),
        h('span', { className: 'find-dot', 'aria-hidden': 'true' }),
        h('span', { style: 'min-width:0' },
          h('span', { className: 'find-title', textContent: finding.path }),
          h('span', { className: 'find-sub', textContent: finding.note })),
        h('span', { className: 'find-count', textContent: String(finding.type || 'finding').replace(/_/g, ' ') })));
    });
    details.append(list);
    trust.append(details);
  }
  stack.append(trust);
  return stack;
}

function overviewFindings(card, story) {
  const out = [];
  (card && card.combos || []).forEach(function(combo, index) {
    out.push({
      title: String(combo.id || 'Risk chain').replace(/-/g, ' '),
      sub: 'Events ' + String(combo.antecedent_seq || '—') + ' → ' + String(combo.consequent_seq || '—') + (combo.note ? ' · ' + clampText(combo.note, 130) : ''),
      count: null,
      open: function() { S.graphSelected = 'F:' + index; S.graphPendingCenter = true; setRoute(sessionHref(S.route.id, 'graph')); }
    });
  });
  const flags = card && card.flags || {};
  Object.keys(flags).sort(function(a, b) { return flags[b] - flags[a]; }).forEach(function(key) {
    out.push({ title: key.replace(/-/g, ' '), sub: 'Flagged actions in this session', count: flags[key], open: function() { S.actFilter = 'flagged'; setRoute(sessionHref(S.route.id, 'activity')); } });
  });
  if (!out.length && story.reconciliation && story.reconciliation.finding_count) {
    const first = (story.reconciliation.findings || [])[0];
    out.push({ title: 'Git discrepancies', sub: 'Recorded mutations differ from repository state', count: story.reconciliation.finding_count, open: function() { if (first && first.seq != null) openEvidence(first.seq); } });
  }
  return out;
}

function turnFlagged(turn) { return Number(turn.flagged || 0) > 0 || Number(turn.max_score || 0) > 0 || Object.keys(turn.flags || {}).length > 0; }

/* ── activity: prompts with their evidence inlined + the sticky rail ──────── */

function hostsByTurn() {
  const map = new Map();
  ((S.blast && S.blast.hosts) || []).forEach(function(host) {
    const index = turnIndexForSeq(host.seq);
    if (index < 0) return;
    const list = map.get(index) || [];
    list.push(host); map.set(index, list);
  });
  return map;
}

function turnEvidenceRows(turn, index, hostMap) {
  const rows = [];
  (turn.steps || []).forEach(function(step) {
    const danger = step.success === 0 || Number(step.score || 0) > 0 || (step.signals || []).length > 0;
    if (!danger) return;
    const signals = (step.signals || []).map(function(signal) { return String(signal).replace(/-/g, ' '); });
    rows.push({
      kind: 'RECORD',
      label: (step.tool || step.type || 'event') + ' · ' + oneLine(step.summary || step.target || 'recorded action'),
      sub: 'seq ' + (step.post_seq || step.seq) + (signals.length ? ' · ' + signals.join(' · ') : step.success === 0 ? ' · failed' : ''),
      seq: step.post_seq || step.seq, danger: true
    });
  });
  (turn.files_changed || []).forEach(function(file) {
    rows.push({
      kind: 'FILE',
      label: basename(file.path),
      sub: (file.status === 'skipped' ? (file.skip_reason || 'not stored') : '+' + Number(file.insertions || 0) + ' −' + Number(file.deletions || 0)) + ' · ' + file.path,
      seq: file.seq, danger: false
    });
  });
  (turn.commits || []).forEach(function(commit) {
    rows.push({
      kind: 'GIT',
      label: commit.subject || commit.kind || 'Git change',
      sub: [commit.ref, String(commit.sha || '').slice(0, 10)].filter(Boolean).join(' · ') || 'recorded git artifact',
      seq: commit.seq, danger: !!commit.force
    });
  });
  (hostMap.get(index) || []).forEach(function(host) {
    rows.push({
      kind: 'HOST',
      label: host.host,
      sub: 'outbound' + (host.via ? ' via ' + host.via : '') + ' · seq ' + host.seq,
      seq: host.seq, danger: true
    });
  });
  return rows;
}

function activityTurns() {
  const hostMap = hostsByTurn();
  return S.story.turns.filter(function(turn, index) {
    if (S.actFilter === 'flagged') return turnFlagged(turn);
    if (S.actFilter === 'evidence') return turnEvidenceRows(turn, index, hostMap).length > 0;
    return true;
  });
}

function renderActivityView() {
  const layout = h('div', { className: 'act-layout', 'aria-label': 'Session activity' });
  const hostMap = hostsByTurn();
  const flaggedCount = S.story.turns.filter(turnFlagged).length;
  let evidenceCount = 0;
  S.story.turns.forEach(function(turn, index) { if (turnEvidenceRows(turn, index, hostMap).length) evidenceCount++; });
  const seg = h('div', { className: 'seg', role: 'group', 'aria-label': 'Filter activity' },
    h('button', { className: S.actFilter === 'all' ? 'active' : '', type: 'button', textContent: 'All', onclick: function() { S.actFilter = 'all'; S.activityCursor = -1; renderPreservingScroll(renderSessionPage); } }),
    h('button', { className: S.actFilter === 'flagged' ? 'active' : '', type: 'button', textContent: 'Flagged · ' + flaggedCount, onclick: function() { S.actFilter = 'flagged'; S.activityCursor = -1; renderPreservingScroll(renderSessionPage); } }),
    h('button', { className: S.actFilter === 'evidence' ? 'active' : '', type: 'button', textContent: 'Has evidence · ' + evidenceCount, onclick: function() { S.actFilter = 'evidence'; S.activityCursor = -1; renderPreservingScroll(renderSessionPage); } })
  );
  const left = h('div', { style: 'min-width:0' },
    h('div', { className: 'act-toolbar' }, seg, h('span', { id: 'activityCount', className: 'act-count' })),
    h('div', { id: 'activityList', className: 'activity-list' }));
  layout.append(left, renderActivityRail());
  setTimeout(renderActivityList, 0);
  return layout;
}

function renderActivityList() {
  const host = document.getElementById('activityList');
  if (!host || !S.story) return;
  host.textContent = '';
  const hostMap = hostsByTurn();
  const turns = activityTurns();
  const count = document.getElementById('activityCount');
  if (count) count.textContent = turns.length + ' of ' + S.story.turns.length;
  if (!turns.length) {
    host.append(h('div', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '⌕' }), h('h2', { textContent: 'Nothing matches this filter' }), h('p', { textContent: 'Switch back to All to see every recorded prompt.' })));
    return;
  }
  turns.forEach(function(turn) { host.append(turnCard(turn, S.story.turns.indexOf(turn), hostMap)); });
}

function turnCard(turn, index, hostMap) {
  const key = turn.prompt_id || 'turn-' + index;
  const open = S.expanded.has(key);
  const flagged = turnFlagged(turn);
  const role = turnRole(turn);
  const evidence = turnEvidenceRows(turn, index, hostMap);
  const meta = [
    (turn.steps || []).length ? (turn.steps || []).length + ' actions' : '',
    fmtSpan(turn.started_at, turn.ended_at),
    tokenCount(turn),
    evidence.length ? evidence.length + ' evidence' : '',
    flagged ? 'flagged' : ''
  ].filter(Boolean).join(' · ');
  const title = turnDisplayTitle(turn, index);
  const card = h('article', { className: 'turn-card' + (flagged ? ' flagged' : ''), id: 'turn-' + (index + 1), 'data-turn-index': String(index) });
  card.append(h('button', { className: 'turn-head', type: 'button', 'aria-expanded': String(open), onclick: function() {
    if (open) S.expanded.delete(key); else S.expanded.add(key);
    renderPreservingScroll(renderActivityList, 'turn-' + (index + 1));
  } },
    h('span', { className: 'turn-index', textContent: pad2(index + 1) }),
    h('span', { className: 'turn-glyph' + (role === 'user' ? ' user' : ''), 'aria-hidden': 'true', textContent: role === 'user' ? '▸' : role === 'agent' ? '⬡' : '⌘' }),
    h('span', { className: 'turn-gist' + (role === 'user' ? ' user' : ''), textContent: title, title: title }),
    h('span', { className: 'turn-meta', textContent: meta })
  ));
  if (open) card.append(turnBody(turn, index, evidence));
  return card;
}

function turnBody(turn, index, evidence) {
  const body = h('div', { className: 'turn-body' });
  if (turn.prompt) body.append(redactedTextBlock(turn.prompt, 'turn-text'));
  else body.append(h('p', { className: 'unavailable-copy', textContent: turn.title_source === 'subagent_action' || turn.title_source === 'subagent_activity' ? 'The host did not emit a user prompt for this subagent activity.' : 'The user prompt was not captured. The title above is derived from recorded activity.' }));
  const model = turn.turn_meta && turn.turn_meta.model || '';
  const chips = [
    turnRole(turn) === 'user' ? 'User prompt' : turnRole(turn) === 'agent' ? 'Agent response' : turnSourceLabel(turn),
    (turn.steps || []).length + ' action' + ((turn.steps || []).length === 1 ? '' : 's'),
    fmtSpan(turn.started_at, turn.ended_at),
    model,
    tokenCount(turn)
  ].filter(Boolean);
  body.append(h('div', { className: 'turn-chips' }, chips.map(function(chip) { return h('span', { textContent: chip }); })));

  if (evidence.length) {
    body.append(h('div', { className: 'mlabel turn-ev-head', textContent: 'Evidence from this turn' }));
    const list = h('div', { className: 'ev-list' });
    evidence.slice(0, 12).forEach(function(item) {
      list.append(h('button', { className: 'ev-row' + (item.danger ? ' danger' : ''), type: 'button', onclick: function() { if (item.seq != null) openEvidence(item.seq); } },
        h('span', { className: 'ev-kind', textContent: item.kind }),
        h('span', { style: 'min-width:0' },
          h('span', { className: 'ev-label', textContent: item.label }),
          h('span', { className: 'ev-sub', textContent: item.sub })),
        h('span', { className: 'ev-act', textContent: 'Open →' })));
    });
    if (evidence.length > 12) list.append(h('div', { className: 'rail-more', textContent: '+' + (evidence.length - 12) + ' more in the full action log' }));
    body.append(list);
  }

  const reason = h('details', { className: 'turn-more' }, h('summary', null, 'Agent reasoning digest', h('span', { className: 'rail-more', style: 'padding:0', textContent: turn.reasoning ? '' : ' · not captured' })));
  reason.append(turn.reasoning ? redactedTextBlock(turn.reasoning, 'reasoning') : h('p', { className: 'unavailable-copy', textContent: 'No assistant explanation was captured for this prompt.' }));
  body.append(reason);

  const steps = h('details', { className: 'turn-more' }, h('summary', { textContent: 'Full action log · ' + (turn.steps || []).length }));
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
  steps.append(stepList);
  body.append(steps);

  body.append(h('div', { style: 'margin-top:12px' }, h('button', { className: 'quiet-button', type: 'button', textContent: 'Trace in Graph →', onclick: function() { openTurnInGraph(turn, index); } })));
  return body;
}

function renderActivityRail() {
  const rail = h('aside', { className: 'rail', 'aria-label': 'Session evidence rail' });
  const hosts = (S.blast && S.blast.hosts) || [];
  const files = (S.story && S.story.files_changed) || [];
  if (!hosts.length && !files.length) {
    rail.append(h('div', { className: 'rail-panel' },
      h('div', { className: 'mlabel rail-head', textContent: 'Evidence' }),
      h('p', { className: 'rail-note', textContent: 'No risk-bearing evidence recorded in this session.' })));
    return rail;
  }
  if (hosts.length) {
    const panel = h('div', { className: 'rail-panel' }, h('div', { className: 'mlabel rail-head', textContent: 'Outbound hosts · ' + hosts.length }));
    hosts.slice(0, 10).forEach(function(host) {
      const index = turnIndexForSeq(host.seq);
      panel.append(h('button', { className: 'rail-row', type: 'button', onclick: function() { jumpToTurn(index, host.seq); } },
        h('span', { className: 'rail-host', textContent: host.host }),
        h('span', { className: 'rail-turn', textContent: index >= 0 ? 'turn ' + (index + 1) + ' →' : 'open →' })));
    });
    if (hosts.length > 10) panel.append(h('div', { className: 'rail-more', textContent: '+' + (hosts.length - 10) + ' more' }));
    rail.append(panel);
  }
  if (files.length) {
    const panel = h('div', { className: 'rail-panel' }, h('div', { className: 'mlabel rail-head', textContent: 'Changed files · ' + files.length }));
    files.slice(0, 10).forEach(function(file) {
      const index = turnIndexForSeq(file.seq);
      panel.append(h('button', { className: 'rail-row', type: 'button', title: file.path, onclick: function() { jumpToTurn(index, file.seq); } },
        h('span', { style: 'min-width:0' },
          h('span', { className: 'rail-file', textContent: basename(file.path) }),
          h('span', { className: 'rail-diff', textContent: '+' + Number(file.insertions || 0) + ' −' + Number(file.deletions || 0) })),
        h('span', { className: 'rail-turn', textContent: index >= 0 ? 'turn ' + (index + 1) + ' →' : 'open →' })));
    });
    if (files.length > 10) panel.append(h('div', { className: 'rail-more', textContent: '+' + (files.length - 10) + ' more' }));
    rail.append(panel);
  }
  return rail;
}

// Jump to (and expand) the turn that owns an event; falls back to the drawer.
function jumpToTurn(index, seq) {
  if (index < 0) { if (seq != null) openEvidence(seq); return; }
  const turn = S.story.turns[index];
  S.expanded.add(turn.prompt_id || 'turn-' + index);
  if (S.actFilter !== 'all' && activityTurns().indexOf(turn) < 0) S.actFilter = 'all';
  renderPreservingScroll(renderSessionPage);
  setTimeout(function() {
    const node = document.getElementById('turn-' + (index + 1));
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 60);
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
