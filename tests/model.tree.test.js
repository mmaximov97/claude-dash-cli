const { test } = require('node:test');
const assert = require('node:assert');
const {
  emptyUsage, addUsage, classifyStatus, computeRollup, flattenVisible, fmtTokens,
} = require('../src/model/tree');

test('addUsage sums element-wise without mutating', () => {
  const a = { in: 1, out: 2, cacheCreate: 3, cacheRead: 4 };
  const b = { in: 10, out: 20, cacheCreate: 30, cacheRead: 40 };
  assert.deepStrictEqual(addUsage(a, b), { in: 11, out: 22, cacheCreate: 33, cacheRead: 44 });
  assert.strictEqual(a.in, 1); // unchanged
});

test('classifyStatus bands by age', () => {
  const now = 1_000_000_000;
  const opts = { liveMs: 30_000, idleMs: 300_000, windowMs: 21_600_000 };
  assert.strictEqual(classifyStatus(now - 5_000, now, opts), 'live');
  assert.strictEqual(classifyStatus(now - 60_000, now, opts), 'idle');
  assert.strictEqual(classifyStatus(now - 3_600_000, now, opts), 'done');
  assert.strictEqual(classifyStatus(now - 40_000_000, now, opts), null);
});

test('computeRollup adds children into parent', () => {
  const node = {
    usage: { in: 1, out: 0, cacheCreate: 0, cacheRead: 0 },
    children: [
      { usage: { in: 2, out: 0, cacheCreate: 0, cacheRead: 0 }, children: [] },
      { usage: { in: 3, out: 0, cacheCreate: 0, cacheRead: 0 }, children: [] },
    ],
  };
  const total = computeRollup(node);
  assert.strictEqual(total.in, 6);
  assert.strictEqual(node.rollup.in, 6);
});

test('flattenVisible only expands ids in the set', () => {
  const nodes = [{ id: 's1', children: [{ id: 'a1', children: [] }] }];
  assert.strictEqual(flattenVisible(nodes, new Set()).length, 1);
  const rows = flattenVisible(nodes, new Set(['s1']));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].depth, 1);
});

test('fmtTokens is human-readable', () => {
  assert.strictEqual(fmtTokens(950), '950');
  assert.strictEqual(fmtTokens(1234), '1.2k');
  assert.strictEqual(fmtTokens(2_000_000), '2.0M');
});
