// tests/watch.poller.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { createPoller } = require('../src/watch/poller');

test('poller calls onUpdate with discover result and re-schedules', () => {
  const calls = [];
  let scheduled = null;
  const p = createPoller({
    intervalMs: 100,
    discover: () => [{ id: 's1' }],
    onUpdate: (s, e) => calls.push({ s, e }),
    setTimeoutFn: (fn) => { scheduled = fn; return 1; },
    clearTimeoutFn: () => {},
  });
  p.start();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].s, [{ id: 's1' }]);
  scheduled(); // fire the next tick manually
  assert.strictEqual(calls.length, 2);
});

test('poller reports discover errors instead of throwing', () => {
  const calls = [];
  const p = createPoller({
    intervalMs: 100,
    discover: () => { throw new Error('boom'); },
    onUpdate: (s, e) => calls.push({ s, e }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  p.start();
  assert.strictEqual(calls[0].s, null);
  assert.match(calls[0].e.message, /boom/);
});
