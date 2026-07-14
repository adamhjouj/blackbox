'use strict';
// #4 — semantic auth-weakening detection (ruleset r4). A capture-time scanner over
// a mutation's ADDED side writes matched pattern names into the hashed
// detail.mutation.weakens; the r4 auth-weaken flag (score 50, MEDIUM alone) READS
// that fact (re-derivable, prune-safe) and arms the injected-tamper combo. Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanAuthWeaken, addedSideOf } = require('../dist/authweaken.js');
const { captureMutation } = require('../dist/mutation.js');
const { evaluateEvent, newRuleCtx } = require('../dist/risk-rules.js');
const { computeSession } = require('../dist/risk-engine.js');
const { verify } = require('../dist/verify.js');
const { ev, normEv, injDetail, tempStore } = require('./util.js');

// ---- scanner: fire cases (one per pattern category) ------------------------
const WEAKENINGS = [
  ['tls-verify-disabled', 'resp = requests.post(url, verify=False)'],
  ['tls-verify-disabled', 'const agent = new https.Agent({ rejectUnauthorized: false })'],
  ['tls-verify-disabled', 'tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}'],
  ['signature-verify-disabled', "jwt.decode(tok, verify_signature=False)"],
  ['signature-verify-disabled', "payload = jwt.decode(t, algorithms=['none'])"],
  ['permission-open', 'permission_classes = [AllowAny]'],
  ['permission-open', '@csrf_exempt\ndef view(request):'],
  ['cors-wildcard', "res.setHeader('Access-Control-Allow-Origin', '*')"],
  ['cors-wildcard', "app.use(cors({ origin: '*' }))"],
  ['auth-bypass', 'const SKIP_AUTH = true  // bypass_auth for local dev'],
  ['hostkey-check-disabled', 'ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())'],
];
for (const [expected, code] of WEAKENINGS) {
  test(`scanner FIRES ${expected}: ${code.slice(0, 42)}`, () => {
    const got = scanAuthWeaken(code);
    assert.ok(got && got.includes(expected), `expected ${expected}, got ${JSON.stringify(got)}`);
  });
}

// ---- scanner: negative controls -------------------------------------------
const CLEAN = [
  'const user = authenticate(req.token)',
  'if (!isAuthorized(user)) throw new ForbiddenError()',
  'response = requests.get(url, verify=True)', // the SAFE form must not fire
  '// TODO: document how CORS origins are configured',
  'permission_classes = [IsAuthenticated]',
];
for (const code of CLEAN) {
  test(`scanner does NOT fire: ${code.slice(0, 42)}`, () => assert.equal(scanAuthWeaken(code), null));
}

// ---- added-side only (the stated ceiling) ---------------------------------
test('a removed guard (- line only) is NOT detected — added-side ceiling', () => {
  const patch = '@@ -1,2 +1,1 @@\n-@login_required\n def view(request):';
  assert.equal(scanAuthWeaken(addedSideOf('patch', patch)), null);
});
test('a weakening INTRODUCED on a + line IS detected', () => {
  const patch = '@@ -1,1 +1,1 @@\n-verify=True\n+verify=False';
  assert.deepEqual(scanAuthWeaken(addedSideOf('patch', patch)), ['tls-verify-disabled']);
});
test('captureMutation records weakens as a fact; clean edits omit it', () => {
  const bad = captureMutation('file_edit', { old_string: 'origin: "https://app.example.com"', new_string: 'origin: "*"' });
  assert.deepEqual(bad.fact.weakens, ['cors-wildcard']);
  const ok = captureMutation('file_edit', { old_string: 'x = 1', new_string: 'x = 2' });
  assert.equal(ok.fact.weakens, undefined, 'clean change adds no field to detail');
});

// ---- flag: r4-only, reads the stored fact (never re-scans) -----------------
const mutDetail = (weakens) => JSON.stringify({ mutation: { kind: 'patch', content_hash: 'sha256:x', bytes: 1, diffstat: { files: 1, insertions: 1, deletions: 0 }, stored: true, weakens } });
const weakHit = (rs) => evaluateEvent(ev(1, { action_type: 'file_edit', target: 'src/api/views.py', detail: mutDetail(['permission-open']) }), newRuleCtx(), rs).find((h) => h.flag === 'auth-weaken');

test('auth-weaken is r4-only (r1/r2/r3 never fire it — replay stays byte-identical)', () => {
  assert.equal(weakHit('r1'), undefined);
  assert.equal(weakHit('r2'), undefined);
  assert.equal(weakHit('r3'), undefined);
  const h = weakHit('r4');
  assert.ok(h, 'r4 fires auth-weaken');
  assert.equal(h.score, 50);
  assert.deepEqual(h.evidence.patterns, ['permission-open']);
  assert.equal(h.evidence.path, 'src/api/views.py');
});

test('a lone auth-weakening edit scores the session MEDIUM under r4 (not HIGH)', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'W', action_type: 'file_edit', target: 'src/util/http.js', detail: mutDetail(['tls-verify-disabled']) }));
    const { verdict } = computeSession(store, 'W', 'r4');
    assert.equal(verdict.verdict, 'medium');
    assert.equal(verdict.rule_counts['auth-weaken'], 1);
    assert.ok(!verdict.combos.length, 'no combo without an injection antecedent');
  } finally {
    store.cleanup();
  }
});

// ---- combo: armed injection → content-weakening = injected-tamper HIGH ------
test('injection then a SEMANTIC auth-weakening edit fires injected-tamper HIGH (r4)', () => {
  const store = tempStore();
  try {
    // A weakening in a file whose PATH is not auth-named — the path-based auth-edit
    // rule would miss this; only the content scan catches it.
    store.append(normEv({ session_id: 'X', action_type: 'web_fetch', target: 'https://docs.site/x', detail: injDetail(['ignore-instructions', 'disregard']) }));
    store.append(normEv({ session_id: 'X', action_type: 'file_edit', target: 'src/api/views.py', detail: mutDetail(['permission-open']) }));
    const { verdict } = computeSession(store, 'X', 'r4');
    assert.equal(verdict.verdict, 'high');
    assert.ok(verdict.combos.some((c) => c.id === 'injected-tamper'), 'injected-tamper should fire on content-weakening');
  } finally {
    store.cleanup();
  }
});

test('the SAME injection+weakening session under r3 does NOT fire the combo (contrast)', () => {
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'X3', action_type: 'web_fetch', target: 'https://docs.site/x', detail: injDetail(['ignore-instructions', 'disregard']) }));
    store.append(normEv({ session_id: 'X3', action_type: 'file_edit', target: 'src/api/views.py', detail: mutDetail(['permission-open']) }));
    const { verdict } = computeSession(store, 'X3', 'r3');
    assert.ok(!verdict.combos.some((c) => c.id === 'injected-tamper'), 'r3 knows nothing of auth-weaken');
    assert.equal(verdict.rule_counts['auth-weaken'] ?? 0, 0);
  } finally {
    store.cleanup();
  }
});

// ---- re-derivability: risk layer never touches the chain -------------------
test('verify() is byte-identical before and after an r4 rescore of an auth-weaken session', () => {
  const { rescoreSession } = require('../dist/risk-engine.js');
  const store = tempStore();
  try {
    store.append(normEv({ session_id: 'V', action_type: 'file_edit', target: 'src/api/views.py', detail: mutDetail(['permission-open']) }));
    const before = JSON.stringify(verify(store));
    rescoreSession(store, 'V', 'r4');
    const after = JSON.stringify(verify(store));
    assert.equal(before, after);
    assert.equal(JSON.parse(after).ok, true);
  } finally {
    store.cleanup();
  }
});
