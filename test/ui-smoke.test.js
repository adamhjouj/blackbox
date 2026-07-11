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
  assert.match(html, /<main id="timeline">/); // the timeline mount point
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

test('the emitted page carries the timeline filter controls', () => {
  const js = clientJs(renderPage());
  // the filter feature must actually be wired into the shipped client script.
  for (const needle of ['buildFilterBar', 'applyFilter', 'rowMatches', 'jumpNext', 'fltFlagged', 'refreshTools']) {
    assert.ok(js.indexOf(needle) >= 0, 'CLIENT_JS should reference ' + needle);
  }
});
