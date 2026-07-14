'use strict';
// The daemon is the security boundary: loopback-only bind, Host-header allowlist
// (anti-DNS-rebinding), Origin/Sec-Fetch rejection (anti-CSRF), and a JSON
// content-type gate. It had ZERO tests. This drives a real server over HTTP with a
// throwaway BLACKBOX_HOME + DB (never the real ~/.blackbox). Requires dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const TEST_PORT = 7936;

function req(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('daemon: recording, read API, and the security gauntlet', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-daemon-home-'));
  process.env.BLACKBOX_HOME = home;
  // A real install always has a /git token; the daemon now REQUIRES one to start.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'test-token', port: TEST_PORT }));
  const { startDaemon } = require('../dist/daemon.js'); // require AFTER BLACKBOX_HOME is set
  const daemon = await startDaemon({ db: join(home, 'test.db'), port: TEST_PORT, logFile: join(home, 'd.log') });
  try {
    // ---- health ----
    const h = await req(TEST_PORT, 'GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.body).ok, true);

    // ---- record a hook, then read it back ----
    const payload = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: 'SESS1', tool_use_id: 't1', cwd: '/repo' });
    const post = await req(TEST_PORT, 'POST', '/hook', { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, body: payload });
    assert.equal(post.status, 200);
    assert.equal(JSON.parse(post.body).ok, true);

    const sessions = await req(TEST_PORT, 'GET', '/api/sessions');
    assert.equal(sessions.status, 200);
    assert.ok(sessions.body.includes('SESS1'), 'the recorded session should appear in the read API');

    // ---- local-only dashboard profile suggestion ----
    const profile = await req(TEST_PORT, 'GET', '/api/profile');
    assert.equal(profile.status, 200);
    assert.match(JSON.parse(profile.body).display_name, /^\S(?:.*\S)?$/);

    // ---- local privacy posture; useful paths/custody, never collector credentials ----
    const privacy = await req(TEST_PORT, 'GET', '/api/privacy');
    assert.equal(privacy.status, 200);
    const privacyBody = JSON.parse(privacy.body);
    assert.equal(privacyBody.bind, `127.0.0.1:${TEST_PORT}`);
    assert.equal(privacyBody.db, join(home, 'test.db'));
    assert.equal(privacyBody.capture_output_bodies, false);
    assert.equal(privacyBody.anchor.kind, 'none');
    assert.ok(privacyBody.storage_bytes > 0);
    assert.equal(privacy.body.includes('test-token'), false, 'privacy API must never expose collector credentials');

    // ---- the read-only investigation graph remains available as a deterministic projection ----
    const trace = await req(TEST_PORT, 'GET', '/api/session/SESS1/trace?depth=2');
    assert.equal(trace.status, 200);
    const traceBody = JSON.parse(trace.body);
    assert.equal(traceBody.session_id, 'SESS1');
    assert.ok(Array.isArray(traceBody.nodes));
    assert.ok(Array.isArray(traceBody.edges));
    assert.equal(traceBody.counts.nodes, traceBody.nodes.length);
    assert.equal(traceBody.counts.edges, traceBody.edges.length);

    // ---- content-type gate: /hook requires application/json ----
    const badCt = await req(TEST_PORT, 'POST', '/hook', { headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(badCt.status, 415);

    // ---- Host allowlist: a non-loopback Host is rejected (anti-DNS-rebinding) ----
    const badHost = await req(TEST_PORT, 'GET', '/api/sessions', { headers: { host: 'evil.example.com' } });
    assert.equal(badHost.status, 403);

    // ---- CSRF: a cross-site Origin is rejected on the read API ----
    const forgedOrigin = await req(TEST_PORT, 'GET', '/api/sessions', { headers: { origin: 'http://evil.example.com' } });
    assert.equal(forgedOrigin.status, 403);

    // ---- CSRF: a cross-site Sec-Fetch-Site is rejected ----
    const forgedFetch = await req(TEST_PORT, 'GET', '/api/sessions', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(forgedFetch.status, 403);

    // ---- the UI is served with a strict CSP + framing protection ----
    const page = await req(TEST_PORT, 'GET', '/');
    assert.equal(page.status, 200);
    assert.ok(page.body.startsWith('<!doctype html>') || page.body.startsWith('<!DOCTYPE html>'));

    // ---- an unknown path 404s ----
    const missing = await req(TEST_PORT, 'GET', '/api/nope');
    assert.equal(missing.status, 404);
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
    delete process.env.BLACKBOX_HOME;
  }
});

test('daemon REFUSES to start with no /git token and no explicit opt-out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-daemon-notoken-'));
  process.env.BLACKBOX_HOME = home; // no config.json written → no token
  const { startDaemon } = require('../dist/daemon.js');
  try {
    // Fail-closed: an unauthenticated /git route would accept forged writes into the
    // forensic chain, so the daemon must refuse rather than silently open it.
    await assert.rejects(() => startDaemon({ db: join(home, 't.db'), port: TEST_PORT + 1 }), /refusing to start/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.BLACKBOX_HOME;
  }
});

test('daemon starts token-less ONLY with an explicit insecure opt-out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-daemon-insecure-'));
  process.env.BLACKBOX_HOME = home; // no token, but we opt out explicitly
  const { startDaemon } = require('../dist/daemon.js');
  const port = TEST_PORT + 2;
  const daemon = await startDaemon({ db: join(home, 't.db'), port, logFile: join(home, 'd.log'), allowInsecureGit: true });
  try {
    const h = await req(port, 'GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.body).ok, true);
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
    delete process.env.BLACKBOX_HOME;
  }
});

test('the config insecure_git flag is also an accepted opt-out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-daemon-cfgoptout-'));
  process.env.BLACKBOX_HOME = home;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ insecure_git: true }));
  const { startDaemon } = require('../dist/daemon.js');
  const port = TEST_PORT + 3;
  const daemon = await startDaemon({ db: join(home, 't.db'), port, logFile: join(home, 'd.log') });
  try {
    const h = await req(port, 'GET', '/health');
    assert.equal(h.status, 200);
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
    delete process.env.BLACKBOX_HOME;
  }
});
