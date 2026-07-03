// tests/harness.index.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { discoverAll, sortSessions } = require('../src/harness');

const CLAUDE = path.join(__dirname, 'fixtures', 'claude');
const CODEX = path.join(__dirname, 'fixtures', 'codex');
const NOW = Date.parse('2026-07-02T14:48:30.000Z');

test('discoverAll merges both harnesses and sorts live-first', () => {
  const all = discoverAll({ now: NOW, windowMs: 24 * 3600_000, claudeDir: CLAUDE, codexDir: CODEX });
  assert.ok(all.length >= 2);
  const harnesses = new Set(all.map((s) => s.harness));
  assert.ok(harnesses.has('claude') && harnesses.has('codex'));
  // sorted: no 'done' appears before a 'live'
  const rank = { live: 0, idle: 1, done: 2 };
  for (let i = 1; i < all.length; i++) {
    assert.ok(rank[all[i - 1].status] <= rank[all[i].status]);
  }
});

test('sortSessions ranks live<idle<done<null and null-status sorts last despite recency', () => {
  const out = sortSessions([
    { id: 'd', status: 'done', lastActivity: 5 },
    { id: 'n', status: null,   lastActivity: 9 },  // most recent, but unranked
    { id: 'l', status: 'live', lastActivity: 1 },
    { id: 'i', status: 'idle', lastActivity: 3 },
  ]);
  assert.deepStrictEqual(out.map((s) => s.id), ['l', 'i', 'd', 'n']);
});
