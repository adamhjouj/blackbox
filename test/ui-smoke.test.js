'use strict';
// The timeline UI is authored as string constants concatenated in renderPage():
// the CSS as a template literal, but the CLIENT_JS with '...'-concatenation ONLY —
// NO backticks and NO ${...} anywhere — because it is itself embedded in the outer
// TS template literal, where a stray backtick or ${ silently corrupts the whole
// page. These smoke tests require the COMPILED output (dist/) and guard exactly
// that failure class: the emitted script must parse, and must hold the convention.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPage } = require('../dist/ui-page.js');

// Pull the client script back out of the emitted page. The tag name is split so
// this file's own source can never be mistaken for the marker it searches for.
const OPEN = '<scr' + 'ipt>';
const CLOSE = '</scr' + 'ipt>';
function clientJs(html) {
  const i = html.indexOf(OPEN);
  const j = html.indexOf(CLOSE, i + OPEN.length);
  assert.ok(i >= 0 && j > i, 'page must contain a single <script> block');
  return html.slice(i + OPEN.length, j);
}

test('renderPage emits a complete, self-contained HTML document', () => {
  const html = renderPage();
  assert.equal(typeof html, 'string');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<main id="main-content"/);
  assert.match(html, /<div id="app" class="app-shell">/);
  assert.doesNotMatch(html, /class="topbar"/);
  assert.match(html, /<\/html>\s*$/);
});

test('CLIENT_JS parses as valid JavaScript', () => {
  const js = clientJs(renderPage());
  assert.ok(js.length > 1000, 'client script should be substantial');
  // new Function() compiles (parses) the body WITHOUT running it — a SyntaxError
  // here is precisely what a bad edit or a stray backtick would produce.
  assert.doesNotThrow(() => new Function(js), 'CLIENT_JS must be syntactically valid');
});

test('CLIENT_JS honours the template-literal safety convention', () => {
  const js = clientJs(renderPage());
  // a raw backtick (char 96) breaks the outer literal — emit one via fromCharCode.
  assert.equal(js.indexOf(String.fromCharCode(96)), -1, 'CLIENT_JS must contain NO raw backtick');
  assert.equal(js.indexOf('${'), -1, 'CLIENT_JS must contain NO ${ interpolation');
});

test('the emitted page carries the dashboard, routing, and evidence controls', () => {
  const js = clientJs(renderPage());
  for (const needle of ['parseRoute', 'renderDashboard', 'renderSessionPage', 'renderOverview', 'renderActivityView', 'renderEvidenceView', 'renderGraphView', 'renderGraphPanel', 'openEvidence']) {
    assert.ok(js.indexOf(needle) >= 0, 'CLIENT_JS should reference ' + needle);
  }
});

test('the graph is a first-class investigation workspace', () => {
  const html = renderPage();
  const js = clientJs(html);
  for (const needle of [
    "{ route: 'overview', label: 'Overview' }",
    "{ route: 'graph', label: 'Graph' }",
    'Focused',
    'Entire session',
    'Focus here',
    'Open evidence',
    'Show in Prompts',
    'toggleGraphDirectory',
    "expand=' + encodeURIComponent",
    'mountGraphCanvas',
    'graphArrowMarker',
    'graphEdgeLabelPoint',
    'selectFirstGraphMatch'
  ]) assert.ok(js.indexOf(needle) >= 0, 'graph workspace should include ' + needle);
  assert.equal(js.indexOf("addEventListener('dblclick'"), -1, 'graph nodes should open details with one click');
  assert.ok(js.indexOf('Math.exp(-limited * 0.0008)') >= 0, 'wheel zoom should use a restrained continuous scale');
  assert.ok(html.indexOf('.graph-layout') >= 0);
  assert.ok(html.indexOf('.graph-inspector') >= 0);
  assert.ok(html.indexOf('.graph-node.selected') >= 0);
});

test('prompts keep their identity, explanations, outcomes, and fast navigation', () => {
  const js = clientJs(renderPage());
  for (const needle of [
    "{ route: 'activity', label: 'Prompts' }",
    'All prompts',
    'turnDisplayTitle',
    'User prompt',
    'Recovered prompt',
    'Agent response / reasoning digest',
    'No assistant explanation was captured',
    'turnFileRow',
    'turnCommitRow',
    'Next flag ↓',
    'jumpNextFlagged',
    'navigateVisibleTurn'
  ]) assert.ok(js.indexOf(needle) >= 0, 'prompt investigation should include ' + needle);
  assert.equal(js.indexOf('Show in Turns'), -1);
});

test('live refresh and prompt expansion preserve scroll position', () => {
  const js = clientJs(renderPage());
  for (const needle of ['setWindowScroll', 'renderPreservingScroll', "renderPreservingScroll(renderActivityList, 'turn-'", 'renderPreservingScroll(renderSessionPage)']) {
    assert.ok(js.indexOf(needle) >= 0, 'scroll stability should include ' + needle);
  }
});

test('the evidence drawer retains the complete forensic dossier and routable context', () => {
  const js = clientJs(renderPage());
  for (const needle of [
    'evidenceHref',
    'eventSeq',
    'Plain-English explanation',
    'Why this is risky',
    'drawerMutationSection',
    "mutation.status === 'pruned'",
    "mutation.status === 'skipped'",
    'Output commitment',
    'Git evidence',
    'Correlation',
    'Redactions',
    'Chain position',
    'Raw redacted record'
  ]) assert.ok(js.indexOf(needle) >= 0, 'forensic dossier should include ' + needle);
});

test('the viewer keeps hostile data on safe DOM rendering paths', () => {
  const html = renderPage();
  const js = clientJs(html);
  assert.equal(js.indexOf('innerHTML'), -1);
  assert.equal(js.indexOf('insertAdjacentHTML'), -1);
  assert.equal(js.indexOf('document.write'), -1);
  assert.ok(js.indexOf('textContent') >= 0);
  assert.match(html, /Skip to content/);
});

test('the viewer ships responsive dashboard and session layouts', () => {
  const html = renderPage();
  for (const needle of ['session-shelf', 'session-card', 'overview-grid', 'evidence-drawer', '@media (max-width: 767px)']) {
    assert.ok(html.indexOf(needle) >= 0, 'page should include ' + needle);
  }
  assert.match(html, /Welcome back/);
  assert.match(html, /blackbox\.displayName/);
});
