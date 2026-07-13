export const EVIDENCE_JS = String.raw`
function renderEvidenceView() {
  const story = S.story;
  const blast = S.blast || {};
  const layout = h('div', { className: 'evidence-layout' });

  const reachPanel = h('section', { className: 'panel evidence-priority' }, h('div', { className: 'panel-label', textContent: 'Risk-bearing evidence' }));
  const reachList = h('div', { className: 'evidence-list' });
  (blast.secrets || []).forEach(function(item) { reachList.append(evidenceEntityRow('Sensitive path', item.path, 'Review →', item.seq, true)); });
  (blast.hosts || []).forEach(function(item) { reachList.append(evidenceEntityRow(item.confirmed ? 'Confirmed outbound host' : 'Outbound host', item.host, (item.via ? 'via ' + item.via + ' · ' : '') + 'Review →', item.seq, true)); });
  (blast.commits || []).forEach(function(item) { reachList.append(evidenceEntityRow(item.force ? 'Destructive git change' : 'Git artifact', item.subject || item.sha, String(item.sha || '').slice(0, 10) + ' · Review →', item.seq, !!item.force)); });
  if (!reachList.children.length) reachPanel.append(h('p', { className: 'summary-copy small', textContent: 'No sensitive path, outbound host, or git-risk artifact was derived from this session.' }));
  else reachPanel.append(reachList);

  const containment = h('section', { className: 'panel containment-panel' }, h('div', { className: 'panel-label', textContent: 'Ordered response' }));
  if ((blast.checklist || []).length) {
    const list = h('ol', { className: 'containment-list' });
    (blast.checklist || []).forEach(function(item) {
      const button = h('button', { className: 'containment-item' + (item.severity === 'high' ? ' danger' : ''), type: 'button', onclick: function() { if (item.seqs && item.seqs.length) openEvidence(item.seqs[0]); } },
        h('span', { className: 'containment-severity', textContent: item.severity }),
        h('span', { textContent: item.action }),
        h('span', { className: 'row-count', textContent: ((item.seqs || []).length || 0) + ' link' + ((item.seqs || []).length === 1 ? '' : 's') + ' →' })
      );
      list.append(h('li', null, button));
    });
    containment.append(list);
  } else containment.append(h('p', { className: 'summary-copy small', textContent: 'No containment action is suggested by the captured facts.' }));
  layout.append(reachPanel, containment);

  const filePanel = h('section', { className: 'panel wide evidence-files' },
    h('div', { className: 'evidence-section-head' },
      h('div', null, h('div', { className: 'panel-label', textContent: 'Changed files' }), h('div', { className: 'row-sub', textContent: story.files_changed.length + ' recorded file outcome' + (story.files_changed.length === 1 ? '' : 's') })),
      h('input', { id: 'evidenceFileSearch', className: 'text-field evidence-search', type: 'search', value: S.evidenceQuery || '', placeholder: 'Filter files…', autocomplete: 'off', 'aria-label': 'Filter changed files' })
    ),
    h('div', { id: 'evidenceFileList', className: 'evidence-list' })
  );
  layout.append(filePanel);
  const fileSearch = filePanel.querySelector('#evidenceFileSearch');
  fileSearch.addEventListener('input', function() { S.evidenceQuery = fileSearch.value; S.evidenceFileLimit = 40; renderEvidenceFiles(); });
  setTimeout(renderEvidenceFiles, 0);

  const integrity = renderIntegrityPanel(story);
  layout.append(integrity);
  return layout;
}

function evidenceEntityRow(kind, title, detail, seq, danger) {
  return h('button', { className: 'result-row evidence-entity' + (danger ? ' danger' : ''), type: 'button', onclick: function() { if (seq != null) openEvidence(seq); } },
    h('span', null, h('span', { className: 'result-title', textContent: title || 'Recorded evidence' }), h('span', { className: 'result-sub', textContent: kind })),
    h('span', { className: 'result-kind', textContent: detail || 'View →' })
  );
}

function renderEvidenceFiles() {
  const host = document.getElementById('evidenceFileList');
  if (!host || !S.story) return;
  host.textContent = '';
  const q = String(S.evidenceQuery || '').trim().toLowerCase();
  const files = (S.story.files_changed || []).filter(function(file) { return !q || String(file.path || '').toLowerCase().indexOf(q) >= 0; });
  const limit = Number(S.evidenceFileLimit || 40);
  files.slice(0, limit).forEach(function(file) { host.append(turnFileRow(file)); });
  if (!files.length) host.append(h('p', { className: 'summary-copy small', textContent: q ? 'No changed file matches this filter.' : 'No stored file mutation was attributed to this session.' }));
  if (files.length > limit) host.append(h('button', { className: 'secondary-button load-more', type: 'button', textContent: 'Show ' + Math.min(40, files.length - limit) + ' more', onclick: function() { S.evidenceFileLimit = limit + 40; renderEvidenceFiles(); } }));
}

function renderIntegrityPanel(story) {
  const panel = h('section', { className: 'panel wide integrity-panel' }, h('div', { className: 'panel-label', textContent: 'Integrity and provenance' }));
  const verify = S.verify;
  panel.append(h('div', { className: 'metric-grid integrity-metrics' },
    metric(verify ? (verify.ok ? 'Verified' : 'Failed') : 'Unknown', 'Hash chain', verify && !verify.ok),
    metric(verify && verify.signed ? 'Signed' : 'Unsigned', 'Checkpoint'),
    metric(verify && verify.head_seq != null ? verify.head_seq : '—', 'Chain head'),
    metric(story.reconciliation && story.reconciliation.finding_count || 0, 'Git discrepancies', story.reconciliation && story.reconciliation.finding_count > 0)
  ));
  if (verify && !verify.ok) panel.append(h('div', { className: 'integrity-alert', textContent: 'Verification failed' + (verify.break_reason ? ': ' + verify.break_reason : '.') }));
  if (verify && verify.latest_sig_seq != null) panel.append(h('p', { className: 'row-sub', textContent: 'Latest signature at sequence ' + verify.latest_sig_seq + (verify.latest_sig_ts ? ' · ' + verify.latest_sig_ts : '') }));

  const recon = story.reconciliation;
  if (recon) {
    const coverage = recon.coverage || {};
    const completeness = coverage.completeness;
    const summary = recon.corroborated ? (recon.finding_count ? recon.finding_count + ' discrepancy finding' + (recon.finding_count === 1 ? '' : 's') : 'Git ground truth corroborates every recorded mutation in scope.') : 'Uncorroborated: ' + String(coverage.reason || 'no git baseline') + '.';
    panel.append(h('div', { className: 'reconciliation-summary' }, h('strong', { textContent: recon.corroborated ? 'Git reconciliation' : 'Git reconciliation unavailable' }), h('span', { textContent: summary })));
    if (completeness) panel.append(h('div', { className: 'reconciliation-summary' }, h('strong', { textContent: 'Capture completeness' }), h('span', { textContent: completeness.recorded + ' of ' + completeness.transcript_tool_uses + ' completed tool calls recorded (' + Math.round(Number(completeness.coverage_ratio || 0) * 100) + '%).' })));
    if ((recon.findings || []).length) {
      const details = h('details', { className: 'forensic-disclosure' }, h('summary', { textContent: 'Show all reconciliation findings' }));
      const list = h('div', { className: 'evidence-list' });
      (recon.findings || []).forEach(function(finding) {
        list.append(h('button', { className: 'result-row', type: 'button', onclick: function() { if (finding.seq != null) openEvidence(finding.seq); } },
          h('span', null, h('span', { className: 'result-title', textContent: finding.path }), h('span', { className: 'result-sub', textContent: finding.note })),
          h('span', { className: 'result-kind danger-text', textContent: String(finding.type || 'finding').replace(/_/g, ' ') })
        ));
      });
      details.append(list); panel.append(details);
    }
    if (completeness && (completeness.missing || []).length) {
      const details = h('details', { className: 'forensic-disclosure' }, h('summary', { textContent: 'Show missing transcript tool calls' }));
      (completeness.missing || []).forEach(function(item) { details.append(h('div', { className: 'reconciliation-summary' }, h('strong', { textContent: item.name || item.id }), h('span', { textContent: item.explained === 'daemon-down' ? 'Known recorder outage' : 'Unexplained capture gap' }))); });
      panel.append(details);
    }
  } else panel.append(h('p', { className: 'row-sub', textContent: 'No git reconciliation was recorded for this session.' }));
  return panel;
}

async function openEvidence(seq, fromRoute) {
  if (seq == null) return;
  const n = Number(seq);
  if (!fromRoute && S.route.page === 'session' && S.route.eventSeq !== n) { setRoute(evidenceHref(S.route.id, S.route.tab, n)); return; }
  S.selectedSeq = n;
  renderDrawerLoading();
  try {
    const detail = await api('/api/event/' + encodeURIComponent(String(n)));
    if (S.selectedSeq !== n) return;
    renderDrawer(detail);
  } catch (_) {
    if (S.selectedSeq === n) renderDrawerError();
  }
}

function drawerShell() {
  closeDrawerNodes();
  const root = document.getElementById('drawerRoot');
  const backdrop = h('div', { className: 'drawer-backdrop', 'aria-hidden': 'true', onclick: closeDrawer });
  const drawer = h('aside', { className: 'evidence-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawerTitle' });
  root.append(backdrop, drawer);
  return drawer;
}

function renderDrawerLoading() {
  const drawer = drawerShell();
  drawer.append(drawerHeader('Loading evidence'), h('div', { className: 'empty-state', 'aria-busy': 'true' }, h('div', { className: 'empty-symbol', textContent: '…' }), h('h2', { textContent: 'Reading the record' })));
}

function drawerHeader(title, seq) {
  const actions = h('div', { className: 'drawer-head-actions' });
  if (seq != null) actions.append(h('button', { className: 'quiet-button', type: 'button', textContent: 'Show in Graph', onclick: function() { closeDrawerNodes(); S.selectedSeq = null; openEventInGraph(seq); } }));
  actions.append(h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close evidence', textContent: '×', onclick: closeDrawer }));
  return h('div', { className: 'drawer-head' }, h('h2', { id: 'drawerTitle', textContent: title }), actions);
}

function renderDrawer(detail) {
  const drawer = drawerShell();
  const action = detail.action_type || detail.type || detail.hook_event || detail.phase || 'Recorded event';
  drawer.append(drawerHeader(action, detail.seq));

  const dl = h('dl', { className: 'kv-grid' });
  addKv(dl, 'Sequence', detail.seq); addKv(dl, 'Time', detail.ts || detail.captured_at); addKv(dl, 'Duration', fmtDur(detail.duration_ms));
  addKv(dl, 'Tool', detail.tool || detail.tool_name); addKv(dl, 'Target', detail.target); addKv(dl, 'Phase', detail.phase); addKv(dl, 'Session', detail.session_id);
  addKv(dl, 'Tool use ID', detail.tool_use_id); addKv(dl, 'Redactions', detail.redaction_count);
  drawer.append(h('section', { className: 'drawer-section first' }, h('h3', { textContent: 'Record' }), dl));

  const explanation = detail.explanation;
  if (explanation) {
    const ex = h('section', { className: 'drawer-section explanation-section' }, h('h3', { textContent: 'Plain-English explanation' }));
    if (typeof explanation === 'string') ex.append(h('p', { className: 'summary-copy small', textContent: explanation }));
    else {
      if (explanation.summary) ex.append(h('p', { className: 'summary-copy small', textContent: explanation.summary }));
      if ((explanation.steps || []).length) {
        const ol = h('ol', { className: 'explanation-steps' });
        explanation.steps.forEach(function(step) { ol.append(h('li', { className: step && step.danger ? 'danger-text' : '', textContent: step && step.text || '' })); });
        ex.append(ol);
      }
      if ((explanation.dangers || []).length) {
        ex.append(h('h4', { textContent: 'Why this is risky' }));
        explanation.dangers.forEach(function(item) { ex.append(h('div', { className: 'danger-explanation' }, h('strong', { textContent: item && item.what || 'Risk' }), h('span', { textContent: item && item.why || '' }))); });
      }
    }
    drawer.append(ex);
  }

  if (detail.mutation) drawer.append(drawerMutationSection(detail.mutation));

  if (detail.risk && (detail.risk.score || (detail.risk.flags || []).length)) {
    const risk = h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Risk interpretation' }));
    const row = h('div', { className: 'risk-line' }, h('strong', { textContent: 'Score ' + Number(detail.risk.score || 0) }));
    (detail.risk.flags || []).forEach(function(flag) { row.append(h('span', { className: 'signal-chip danger', textContent: String(flag).replace(/-/g, ' ') })); });
    risk.append(row);
    if (detail.risk.evidence) risk.append(forensicDetails('Machine evidence', detail.risk.evidence));
    drawer.append(risk);
  }

  const input = detail.raw && typeof detail.raw === 'object' ? detail.raw.tool_input : null;
  if (input != null) drawer.append(h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Tool input' + (detail.redaction_count ? ' · redacted' : '') }), redactedTextBlock(typeof input === 'string' ? input : JSON.stringify(input, null, 2), 'drawer-pre')));
  if (detail.output_hash) drawer.append(h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Output commitment' }), h('pre', { textContent: 'Content elided\nsha-256  ' + detail.output_hash + '\nbytes    ' + Number(detail.output_size_bytes || 0) })));

  const collector = detail.detail && typeof detail.detail === 'object' ? detail.detail : {};
  if (collector.git) drawer.append(drawerGitSection(collector.git));
  if (collector.correlation) {
    const corr = h('dl', { className: 'kv-grid' });
    addKv(corr, 'Confidence', collector.correlation.confidence); addKv(corr, 'Cause session', collector.correlation.session_id); addKv(corr, 'Cause event', collector.correlation.seq || collector.correlation.event_id);
    drawer.append(h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Correlation' }), corr));
  }
  const reds = collector.redactions || collector.redaction;
  if (Array.isArray(reds) && reds.length) {
    const section = h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Redactions' }));
    reds.forEach(function(item) { section.append(h('div', { className: 'redaction-row' }, h('strong', { textContent: item && item.type || 'redacted' }), h('span', { textContent: (item && item.path || '') + (item && item.bytes != null ? ' · ' + item.bytes + ' bytes' : '') }))); });
    drawer.append(section);
  }

  const chain = h('dl', { className: 'kv-grid' });
  addKv(chain, 'Sequence', detail.seq); addKv(chain, 'Previous hash', detail.seq === 1 ? 'genesis' : detail.prev_hash); addKv(chain, 'Event hash', detail.hash);
  drawer.append(h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Chain position' }), chain));
  drawer.append(forensicDetails('Raw redacted record', detail.raw));
  if (detail.detail) drawer.append(forensicDetails('Collector detail', detail.detail));
  setTimeout(function() { const close = drawer.querySelector('.icon-button'); if (close) close.focus(); }, 0);
}

function drawerMutationSection(mutation) {
  const section = h('section', { className: 'drawer-section' }, h('h3', { textContent: mutation.kind === 'body' ? 'Stored file contents' : 'Recorded changes' }));
  const ds = mutation.diffstat || {};
  section.append(h('div', { className: 'diffstat-line' },
    h('span', { textContent: '+' + Number(ds.insertions || 0) }), h('span', { textContent: '−' + Number(ds.deletions || 0) }),
    h('span', { textContent: Number(ds.files || 1) + ' file' + (Number(ds.files || 1) === 1 ? '' : 's') }),
    mutation.redacted ? h('span', { className: 'danger-text', textContent: 'Secrets redacted' }) : null
  ));
  if (mutation.status === 'available' && mutation.content != null) {
    const pre = h('pre', { className: 'diff-view' });
    const lines = String(mutation.content).split('\n');
    lines.slice(0, 400).forEach(function(line) { pre.append(h('span', { className: mutation.kind === 'body' || line.charAt(0) === '+' ? 'diff-add' : line.charAt(0) === '-' ? 'diff-remove' : 'diff-context', textContent: line || ' ' })); });
    section.append(pre);
    if (lines.length > 400) section.append(h('p', { className: 'row-sub', textContent: (lines.length - 400) + ' additional lines are not shown.' }));
  } else if (mutation.status === 'pruned') section.append(h('div', { className: 'mutation-state', textContent: 'Content aged out' + (mutation.pruned_at ? ' on ' + String(mutation.pruned_at).slice(0, 10) : '') + '. The chain retains its ' + Number(mutation.bytes || 0) + '-byte commitment.' }));
  else if (mutation.status === 'skipped') section.append(h('div', { className: 'mutation-state', textContent: 'Content was not stored (' + (mutation.skip_reason || 'skipped') + '). Size and sha-256 commitment remain in the record.' }));
  return section;
}

function drawerGitSection(git) {
  const dl = h('dl', { className: 'kv-grid' });
  addKv(dl, 'Ref', git.ref); addKv(dl, 'Kind', git.kind); addKv(dl, 'Old SHA', git.old_sha); addKv(dl, 'New SHA', git.new_sha);
  if (git.commit) { addKv(dl, 'Commit', git.commit.sha); addKv(dl, 'Subject', git.commit.subject); addKv(dl, 'Author', git.commit.author); }
  const flags = ['is_force','is_reset','is_delete','is_amend'].filter(function(key) { return git[key]; }).map(function(key) { return key.slice(3); });
  addKv(dl, 'Destructive flags', flags);
  if (git.diffstat) addKv(dl, 'Diffstat', '+' + Number(git.diffstat.insertions || 0) + ' −' + Number(git.diffstat.deletions || 0) + ' · ' + Number(git.diffstat.files || 0) + ' files');
  return h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Git evidence' }), dl);
}

function forensicDetails(label, value) {
  const details = h('details', { className: 'forensic-disclosure drawer-section' }, h('summary', { textContent: label }));
  details.append(h('pre', { textContent: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }));
  return details;
}

function addKv(dl, label, value) { if (value == null || value === '' || (Array.isArray(value) && !value.length)) return; dl.append(h('dt', { textContent: label }), h('dd', { textContent: Array.isArray(value) ? value.join(', ') : String(value) })); }

function renderDrawerError() {
  const drawer = drawerShell();
  drawer.append(drawerHeader('Evidence unavailable'), h('div', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '×' }), h('h2', { textContent: 'The event could not be loaded' }), h('p', { textContent: 'Close this panel and try the event again.' })));
}

function closeDrawerNodes() { document.getElementById('drawerRoot').textContent = ''; }
function closeDrawer() {
  if (S.route && S.route.eventSeq != null) { history.back(); return; }
  S.selectedSeq = null; closeDrawerNodes();
}
`;
