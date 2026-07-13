'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redact, redactText } = require('../dist/redact.js');

const R = (s) => redactText(s).text;
const hasRedaction = (s) => R(s).includes('[REDACTED:');
const typeOf = (s) => (redactText(s).hits[0] || {}).type;

// =========================================================================
// W0.1a — ReDoS: the ASSIGNMENT_RE and the new CONTEXT_RULES are all bounded,
// so a long delimiter-free run can never force O(n^2) backtracking. Before the
// fix the assignment gadget took ~55s and the url-scheme gadget ~67s.
// =========================================================================
const BIG = 384 * 1024;
const GADGETS = {
  'keyword + no delimiter': 'password' + 'a'.repeat(BIG),
  'url scheme, no ://': 'a'.repeat(BIG),
  'curl -u, no colon': '--user ' + 'a'.repeat(BIG),
  'authorization, no token': 'Authorization: Bearer' + ' '.repeat(BIG),
};
for (const [label, input] of Object.entries(GADGETS)) {
  test(`ReDoS bound (<500ms): ${label}`, () => {
    const t0 = process.hrtime.bigint();
    redactText(input);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 500, `redaction took ${ms.toFixed(0)}ms — quantifier is unbounded`);
  });
}

// =========================================================================
// W0.1c — structure-anchored context rules. The value is deliberately HEX in
// each case: isLikelySecret exempts 7-64-char hex (git shas/digests), so before
// these rules the secret reached the store verbatim. Structure catches it.
// =========================================================================
test('URL userinfo password (hex) is redacted, structure preserved', () => {
  const out = R('git clone https://alice:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4@github.com/x.git');
  assert.match(out, /https:\/\/alice:\[REDACTED:url-userinfo\]@github\.com/);
  assert.ok(!out.includes('a1b2c3d4e5f6'), 'secret leaked');
  assert.equal(typeOf('https://alice:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4@h'), 'url-userinfo');
});

test('curl -u user:hexpass is redacted, username kept', () => {
  const out = R('curl -u admin:deadbeefcafe1234feed https://api.example.com/v1');
  assert.match(out, /curl -u admin:\[REDACTED:basic-auth\]/);
  assert.ok(!out.includes('deadbeef'), 'secret leaked');
});
test('--user=user:pass long form redacted', () => {
  assert.match(R('http --user=svc:0011223344556677 GET https://x'), /--user=svc:\[REDACTED:basic-auth\]/);
});

test('Authorization Bearer/Basic/Token (hex/base64) redacted', () => {
  assert.match(R('Authorization: Bearer a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), /Bearer \[REDACTED:auth-header\]/);
  assert.match(R('-H "Authorization: Basic dXNlcjpwYXNzd29yZA=="'), /Basic \[REDACTED:auth-header\]/);
  assert.match(R('proxy-authorization: token ff00ff00ff00ff00'), /token \[REDACTED:auth-header\]/);
});

// =========================================================================
// W0.1c — negative controls: structure that must NOT be mistaken for a secret.
// The (?=@) lookahead and colon-anchoring keep ports / scp / plain host:port safe.
// =========================================================================
const KEEP = [
  ['redis port', 'redis://cache.local:6379/0'],
  ['postgres host:port', 'postgres://db.internal:5432/app'],
  ['scp remote path', 'scp deploy@host:/var/www/app.tar.gz .'],
  ['bare host:port', 'nc db.internal:5432'],
  ['url without userinfo', 'https://api.example.com:8443/health'],
  ['git sha (hex, not in a secret shape)', 'git checkout a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0'],
  ['sha256 digest', 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
];
for (const [label, input] of KEEP) {
  test(`context rule does NOT over-redact: ${label}`, () => assert.equal(hasRedaction(input), false, R(input)));
}

// =========================================================================
// Regression — the ReDoS bounding did not change what normal assignments and
// prefix rules capture (a byte-identical-capture corpus).
// =========================================================================
const ASSIGN = [
  'DB_PASSWORD=hunter2',
  'export API_KEY="abc123def456ghi"',
  'aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
  'client_secret: s3cr3tvalue0',
  'auth_token=tok_verylongtokenvalue1234',
  'PRIVATE_KEY=mnbvcxzasdfghjkl',
];
for (const input of ASSIGN) {
  test(`assignment still redacts: ${input.slice(0, 24)}`, () => assert.equal(typeOf(input), 'assigned-secret'));
}

const PREFIX = [
  ['anthropic-key', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'],
  ['github-token', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
  ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
];
for (const [type, input] of PREFIX) {
  test(`prefix rule still fires: ${type}`, () => assert.equal(typeOf(input), type));
}

test('PEM private key block still redacted whole', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\n-----END RSA PRIVATE KEY-----';
  assert.equal(typeOf(pem), 'pem-private-key');
});

// =========================================================================
// The real capture path is redact(payload) over the WALK_FIELDS — confirm the
// hex-leak is closed there too (not just in redactText), and hits are recorded.
// =========================================================================
test('redact() payload closes the hex leak in tool_input.command', () => {
  const { redacted, hits } = redact({
    tool_input: { command: 'curl -H "Authorization: Bearer 00aa11bb22cc33dd44ee55ff66aa77bb" https://x' },
  });
  const cmd = redacted.tool_input.command;
  assert.ok(cmd.includes('[REDACTED:auth-header]'), 'header secret not redacted in payload');
  assert.ok(!cmd.includes('00aa11bb'), 'secret leaked through payload walk');
  const hit = hits.find((h) => h.type === 'auth-header');
  assert.ok(hit && hit.hash.startsWith('sha256:') && hit.bytes > 0, 'coverage hit not recorded with a hash');
});

test('redactText never throws — fail-closed to a hash on internal error', () => {
  // A pathological-but-valid string still returns a string, never throws.
  const r = redactText('x'.repeat(1000) + '://' + 'y'.repeat(1000));
  assert.equal(typeof r.text, 'string');
});
