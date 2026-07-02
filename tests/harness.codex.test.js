// tests/harness.codex.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { discoverSessions } = require('../src/harness/codex');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const NOW = Date.parse('2026-07-02T14:48:30.000Z');

test('discoverSessions returns flat sessions with cumulative usage from the last token_count', () => {
  const sessions = discoverSessions({ sessionsDir: FIX, now: NOW });
  assert.strictEqual(sessions.length, 1);
  const s = sessions[0];
  assert.strictEqual(s.harness, 'codex');
  assert.strictEqual(s.id, 'cx1');
  assert.strictEqual(s.model, 'gpt-5-codex');
  assert.strictEqual(s.children.length, 0);
  // last token_count: in = 3000-900, out = 500+100, cacheRead = 900
  assert.strictEqual(s.usage.in, 2100);
  assert.strictEqual(s.usage.out, 600);
  assert.strictEqual(s.usage.cacheRead, 900);
  assert.deepStrictEqual(s.rollup, s.usage);
});

test('missing sessionsDir yields empty array', () => {
  assert.deepStrictEqual(discoverSessions({ sessionsDir: '/no/such', now: NOW }), []);
});
