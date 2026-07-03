const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { discoverSessions } = require('../src/harness/claude');

const FIX = path.join(__dirname, 'fixtures', 'claude');
// now = 30s after the subagent's last activity, well inside the window
const NOW = Date.parse('2026-07-02T12:01:30.000Z');

test('discoverSessions builds a session with its subagent child', () => {
  const sessions = discoverSessions({ projectsDir: FIX, now: NOW });
  assert.strictEqual(sessions.length, 1);
  const s = sessions[0];
  assert.strictEqual(s.id, 'sess-A');
  assert.strictEqual(s.project, 'proj');
  assert.strictEqual(s.children.length, 1);
  assert.strictEqual(s.children[0].agentType, 'Explore');
});

test('usage is attributed per agent, not merged by sessionId', () => {
  const s = discoverSessions({ projectsDir: FIX, now: NOW })[0];
  // parent own usage: in 300, out 130
  assert.strictEqual(s.usage.in, 300);
  assert.strictEqual(s.usage.out, 130);
  // child own usage separate
  assert.strictEqual(s.children[0].usage.in, 40);
  // rollup = parent + child
  assert.strictEqual(s.rollup.in, 340);
  assert.strictEqual(s.rollup.out, 140);
});

test('missing projectsDir yields empty array, no throw', () => {
  assert.deepStrictEqual(discoverSessions({ projectsDir: '/no/such/dir', now: NOW }), []);
});
