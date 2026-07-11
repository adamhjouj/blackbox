'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  armsTamper, isStrongAuthPath, isTestPath, isCiBuildPath, isUntrustedOutputChannel, mcpOutboundSensitiveFile,
} = require('../dist/risk-rules.js');
const { ev } = require('./util.js');

test('armsTamper (mcp_call): one STRONG marker arms', () => {
  assert.equal(armsTamper(['ignore-instructions'], 'mcp_call'), true);
  assert.equal(armsTamper(['disregard'], 'mcp_call'), true);
  assert.equal(armsTamper(['override-safety'], 'mcp_call'), true);
  assert.equal(armsTamper(['conceal-from-user'], 'mcp_call'), true);
});

test('armsTamper (mcp_call): a lone CORROBORATE marker does NOT arm', () => {
  assert.equal(armsTamper(['you-are-now'], 'mcp_call'), false);
  assert.equal(armsTamper(['new-instructions'], 'mcp_call'), false);
});

test('armsTamper: two distinct corroborate markers arm (either channel)', () => {
  assert.equal(armsTamper(['you-are-now', 'new-instructions'], 'mcp_call'), true);
  assert.equal(armsTamper(['you-are-now', 'new-instructions'], 'web_fetch'), true);
});

test('armsTamper (web_fetch): a lone STRONG marker does NOT arm (research FP control)', () => {
  assert.equal(armsTamper(['ignore-instructions'], 'web_fetch'), false); // a page quoting one marker
  assert.equal(armsTamper(['ignore-instructions', 'disregard'], 'web_fetch'), true); // corroborated
});

test('armsTamper: NEVER-arm markers never arm', () => {
  assert.equal(armsTamper(['reveal-prompt'], 'mcp_call'), false);
  assert.equal(armsTamper(['fake-role-tag'], 'mcp_call'), false);
  assert.equal(armsTamper(['reveal-prompt', 'fake-role-tag'], 'mcp_call'), false);
});

test('isStrongAuthPath: real auth files match, middleware/guard/author.ts do NOT', () => {
  assert.equal(isStrongAuthPath('src/auth/session.ts'), true);
  assert.equal(isStrongAuthPath('src/auth/oauth.ts'), true);
  assert.equal(isStrongAuthPath('lib/password.py'), true);
  assert.equal(isStrongAuthPath('src/middleware.ts'), false); // dropped from strong set
  assert.equal(isStrongAuthPath('src/guard.ts'), false);
  assert.equal(isStrongAuthPath('src/author.ts'), false); // segment boundary
});

test('isTestPath', () => {
  assert.equal(isTestPath('tests/auth/login.test.ts'), true);
  assert.equal(isTestPath('src/__tests__/x.ts'), true);
  assert.equal(isTestPath('spec/y.ts'), true);
  assert.equal(isTestPath('src/auth/session.ts'), false);
});

test('isCiBuildPath', () => {
  assert.equal(isCiBuildPath('.github/workflows/deploy.yml'), true);
  assert.equal(isCiBuildPath('package.json'), true);
  assert.equal(isCiBuildPath('Makefile'), true);
  assert.equal(isCiBuildPath('.gitlab-ci.yml'), true);
  assert.equal(isCiBuildPath('src/index.ts'), false);
  assert.equal(isCiBuildPath('README.md'), false);
});

test('isUntrustedOutputChannel: only web_fetch / mcp_call', () => {
  assert.equal(isUntrustedOutputChannel(ev(1, { action_type: 'web_fetch' })), true);
  assert.equal(isUntrustedOutputChannel(ev(1, { action_type: 'mcp_call' })), true);
  assert.equal(isUntrustedOutputChannel(ev(1, { action_type: 'file_read' })), false);
  assert.equal(isUntrustedOutputChannel(ev(1, { action_type: 'shell_command' })), false);
});

test('mcpOutboundSensitiveFile: finds a sensitive path in the outbound JSON', () => {
  const e = ev(1, { action_type: 'mcp_call', target: JSON.stringify({ file_path: '/app/.env' }) });
  assert.equal(mcpOutboundSensitiveFile(e), '/app/.env');
  const clean = ev(2, { action_type: 'mcp_call', target: JSON.stringify({ query: 'hello world' }) });
  assert.equal(mcpOutboundSensitiveFile(clean), null);
  const notMcp = ev(3, { action_type: 'file_read', target: '/app/.env' });
  assert.equal(mcpOutboundSensitiveFile(notMcp), null); // gated on action_type
});
