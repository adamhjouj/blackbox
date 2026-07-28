'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeAndCapture } = require('../dist/normalize.js');
const { rescoreSession } = require('../dist/risk-engine.js');
const { sessionCards, sessionStory, eventDetail, sessionTrace } = require('../dist/read-api.js');
const { buildReport } = require('../dist/report.js');
const { blastRadius } = require('../dist/blast.js');
const { toOtlp } = require('../dist/otel.js');
const { verify } = require('../dist/verify.js');
const { tempStore } = require('./util.js');

const RISKY = '10000000-0000-4000-8000-000000000002';

function attrOf(span, key) {
  const item = span.attributes.find((attribute) => attribute.key === key);
  if (!item) return undefined;
  return item.value.stringValue ?? item.value.intValue ?? item.value.boolValue ?? item.value.doubleValue;
}

function ingestDemo(store) {
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'examples', 'demo-events.jsonl'), 'utf8');
  for (const line of fixture.trim().split('\n')) {
    const payload = JSON.parse(line);
    const captured = payload._captured_at || '2026-01-15T00:00:00.000Z';
    const { event, blob } = normalizeAndCapture(payload, captured);
    store.append(event, blob);
  }
  rescoreSession(store, RISKY, 'r4');
}

test('the canonical failed-upload demo is HIGH without claiming data was sent', () => {
  const store = tempStore();
  try {
    ingestDemo(store);
    const integrityBefore = verify(store);
    const card = sessionCards(store).find((item) => item.session_id === RISKY);
    assert.equal(card.verdict, 'high');
    assert.equal(card.findings, 1);
    assert.equal(card.flagged, 0);
    assert.equal(card.review_count, 1);
    assert.equal(card.combos[0].outcome, 'failed');
    assert.match(card.combos[0].display_note, /submitted for transfer/);
    assert.doesNotMatch(card.combos[0].display_note, /\.env sent to/);

    const story = sessionStory(store, RISKY);
    const bash = story.turns.flatMap((turn) => turn.steps).find((step) => step.tool === 'Bash');
    assert.equal(bash.outcome, 'failed');
    assert.equal(bash.score, 0);
    assert.equal(bash.findings.length, 1);

    const pre = eventDetail(store, bash.seq);
    const failure = eventDetail(store, bash.post_seq);
    for (const detail of [pre, failure]) {
      assert.equal(detail.action_outcome, 'failed');
      assert.equal(detail.findings[0].severity, 'high');
      assert.equal(detail.findings[0].outcome, 'failed');
      assert.equal(detail.risk && detail.risk.score || 0, 0);
      assert.doesNotMatch(JSON.stringify(detail.explanation), /Sent data to an external server/);
    }

    const trace = sessionTrace(store, RISKY, { whole: true });
    assert.ok(trace.edges.some((edge) => edge.rel === 'targeted'));
    assert.equal(trace.edges.some((edge) => edge.rel === 'sent'), false);

    const report = buildReport(store, RISKY, 'r4');
    assert.match(report, /Outcome: FAILED/);
    assert.match(report, /observed no successful completion/);
    assert.doesNotMatch(report, /\.env sent to/);

    const blast = blastRadius(store, RISKY);
    assert.equal(blast.hosts[0].outcome, 'failed');
    assert.ok(blast.checklist.some((item) => /failed outbound-transfer attempt/.test(item.action)));
    assert.equal(blast.checklist.some((item) => /combo-confirmed exfil/.test(item.action)), false);

    const spans = toOtlp(store, [RISKY]).resourceSpans[0].scopeSpans[0].spans;
    const bashSpan = spans.find((span) => attrOf(span, 'gen_ai.tool.name') === 'Bash');
    assert.equal(attrOf(bashSpan, 'blackbox.action.outcome'), 'failed');
    assert.equal(bashSpan.status.code, 2);
    assert.ok((bashSpan.events || []).some((event) => event.name === 'blackbox.session_finding'));

    assert.deepEqual(verify(store), integrityBefore, 'all outcome projections must leave the chain byte-identical');
  } finally {
    store.cleanup();
  }
});

