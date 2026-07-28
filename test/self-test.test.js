'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSelfTest } = require('../dist/self-test.js');

test('self-test exercises the complete pipeline in disposable state', async () => {
  const beforeHome = process.env.BLACKBOX_HOME;
  const beforeDb = process.env.BLACKBOX_DB;
  const result = await runSelfTest();

  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
  assert.equal(result.events, 2);
  assert.equal(result.verdict, 'high');
  assert.deepEqual(result.checks.map((item) => item.name), [
    'Ephemeral recorder',
    'Hook capture',
    'Redaction',
    'Risk interpretation',
    'Evidence chain',
  ]);
  assert.equal(process.env.BLACKBOX_HOME, beforeHome);
  assert.equal(process.env.BLACKBOX_DB, beforeDb);
});
