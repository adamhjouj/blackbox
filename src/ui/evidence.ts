export const EVIDENCE_JS = String.raw`
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

function drawerHeader(title, seq, tag, danger) {
  const head = h('div', { className: 'drawer-head' }, h('h2', { id: 'drawerTitle', textContent: title }));
  if (tag) head.append(h('span', { className: 'tag-chip' + (danger ? '' : ' plain'), textContent: tag }));
  const actions = h('div', { className: 'drawer-head-actions' });
  if (seq != null) actions.append(h('button', { className: 'quiet-button', type: 'button', textContent: 'Show in graph', onclick: function() { closeDrawerNodes(); S.selectedSeq = null; openEventInGraph(seq); } }));
  actions.append(h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Close evidence', textContent: '×', onclick: closeDrawer }));
  head.append(actions);
  return head;
}

function renderDrawerLoading() {
  const drawer = drawerShell();
  drawer.append(drawerHeader('Loading evidence'), h('div', { className: 'drawer-body', 'aria-busy': 'true' }, h('div', { className: 'skeleton-card' })));
}

function renderDrawer(detail) {
  const drawer = drawerShell();
  const action = detail.action_type || detail.type || detail.hook_event || detail.phase || 'Recorded event';
  const flags = detail.risk && detail.risk.flags || [];
  const tag = flags.length ? String(flags[0]).replace(/-/g, ' ') : action;
  drawer.append(drawerHeader(detail.tool || detail.tool_name || action, detail.seq, tag, flags.length > 0));
  const body = h('div', { className: 'drawer-body' });
  drawer.append(body);

  const dl = h('dl', { className: 'kv-grid' });
  addKv(dl, 'Sequence', detail.seq); addKv(dl, 'Time', detail.ts || detail.captured_at); addKv(dl, 'Duration', fmtDur(detail.duration_ms));
  addKv(dl, 'Tool', detail.tool || detail.tool_name); addKv(dl, 'Target', detail.target); addKv(dl, 'Phase', detail.phase); addKv(dl, 'Session', detail.session_id);
  addKv(dl, 'Tool use ID', detail.tool_use_id); addKv(dl, 'Redactions', detail.redaction_count);
  body.append(h('section', { className: 'drawer-section first' }, h('h3', { textContent: 'Record' }), dl));

  const explanation = detail.explanation;
  if (explanation) {
    const ex = h('section', { className: 'drawer-section explanation-section' }, h('h3', { textContent: 'Plain-English explanation' }));
    if (typeof explanation === 'string') ex.append(h('p', { className: 'summary-copy small', textContent: explanation }));
    else {
      if (explanation.summary) ex.append(h('p', { className: 'explain-title', textContent: explanation.summary }));
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
    body.append(ex);
  }

  if (detail.mutation) body.append(drawerMutationSection(detail.mutation));

  if (detail.risk && (detail.risk.score || (detail.risk.flags || []).length)) {
    const score = Math.max(0, Math.min(100, Number(detail.risk.score || 0)));
    const risk = h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Risk interpretation' }));
    const row = h('div', { className: 'risk-line' }, h('strong', { textContent: 'Score ' + Number(detail.risk.score || 0) }));
    (detail.risk.flags || []).forEach(function(flag) { row.append(h('span', { className: 'tag-chip', textContent: String(flag).replace(/-/g, ' ') })); });
    row.append(h('span', { className: 'who', textContent: 'machine evidence' }));
    risk.append(row);
    const bar = h('div', { className: 'risk-score-bar' }, h('i'));
    bar.firstChild.style.width = score + '%';
    risk.append(bar);
    if (detail.risk.evidence) risk.append(forensicDetails('Machine evidence', detail.risk.evidence));
    body.append(risk);
  }

  const input = detail.raw && typeof detail.raw === 'object' ? detail.raw.tool_input : null;
  if (input != null) body.append(h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Tool input' + (detail.redaction_count ? ' · redacted' : '') }), redactedTextBlock(typeof input === 'string' ? input : JSON.stringify(input, null, 2), 'drawer-pre')));
  if (detail.output_hash) body.append(h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Output commitment' }), h('pre', { textContent: 'Content elided\nsha-256  ' + detail.output_hash + '\nbytes    ' + Number(detail.output_size_bytes || 0) })));

  const collector = detail.detail && typeof detail.detail === 'object' ? detail.detail : {};
  if (collector.git) body.append(drawerGitSection(collector.git));
  if (collector.correlation) {
    const corr = h('dl', { className: 'kv-grid' });
    addKv(corr, 'Confidence', collector.correlation.confidence); addKv(corr, 'Cause session', collector.correlation.session_id); addKv(corr, 'Cause event', collector.correlation.seq || collector.correlation.event_id);
    body.append(h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Correlation' }), corr));
  }
  const reds = collector.redactions || collector.redaction;
  if (Array.isArray(reds) && reds.length) {
    const section = h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Redactions' }));
    reds.forEach(function(item) { section.append(h('div', { className: 'redaction-row' }, h('strong', { textContent: item && item.type || 'redacted' }), h('span', { textContent: (item && item.path || '') + (item && item.bytes != null ? ' · ' + item.bytes + ' bytes' : '') }))); });
    body.append(section);
  }

  const chain = h('dl', { className: 'kv-grid' });
  addKv(chain, 'Sequence', detail.seq); addKv(chain, 'Previous hash', detail.seq === 1 ? 'genesis' : detail.prev_hash); addKv(chain, 'Event hash', detail.hash);
  body.append(h('section', { className: 'drawer-section' }, h('h3', { textContent: 'Chain position' }), chain));
  body.append(forensicDetails('Raw redacted record', detail.raw));
  if (detail.detail) body.append(forensicDetails('Collector detail', detail.detail));
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
    if (lines.length > 400) section.append(h('p', { className: 'unavailable-copy', textContent: (lines.length - 400) + ' additional lines are not shown.' }));
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
  drawer.append(drawerHeader('Evidence unavailable'), h('div', { className: 'drawer-body' }, h('div', { className: 'empty-state' }, h('div', { className: 'empty-symbol', textContent: '×' }), h('h2', { textContent: 'The event could not be loaded' }), h('p', { textContent: 'Close this panel and try the event again.' }))));
}

function closeDrawerNodes() { document.getElementById('drawerRoot').textContent = ''; }
function closeDrawer() {
  if (S.route && S.route.eventSeq != null) { history.back(); return; }
  S.selectedSeq = null; closeDrawerNodes();
}
`;
