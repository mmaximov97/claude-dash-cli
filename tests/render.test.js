const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/render');

function baseState(limits, overrides = {}) {
  return {
    error: null,
    stats: null,
    latest: {
      timestamp: Date.now(),
      limits,
      spend: null,
      extra_usage: null,
      ...overrides,
    },
  };
}

test('active row shows the percent-based color and no inactive tag', () => {
  const state = baseState({
    session: { label: '5H', utilization: 23, timeToReset: 0, estimatedTimeToLimit: null, confidence: 'none', isActive: true },
  });
  const out = render(state);
  assert.match(out, /5H/);
  assert.ok(out.includes('\x1b[38;5;82m'), 'expected the green (<40%) colorForPct code for an active row');
  assert.ok(!out.includes('(inactive)'));
});

test('inactive row is dimmed instead of percent-colored, and tagged', () => {
  const state = baseState({
    'weekly_scoped:Fable': { label: 'Fable 7D', utilization: 1, timeToReset: 0, estimatedTimeToLimit: null, confidence: 'none', isActive: false },
  });
  const out = render(state);
  assert.ok(out.includes('(inactive)'));
  assert.ok(!out.includes('\x1b[38;5;82m'), 'inactive row must not use the utilization color gradient');
});

test('banner ignores a high-utilization but inactive limit', () => {
  const state = baseState({
    session: { label: '5H', utilization: 10, timeToReset: 0, estimatedTimeToLimit: null, confidence: 'none', isActive: true },
    'weekly_scoped:Fable': { label: 'Fable 7D', utilization: 99, timeToReset: 0, estimatedTimeToLimit: null, confidence: 'none', isActive: false },
  });
  const out = render(state);
  assert.ok(!out.includes('WARNING') && !out.includes('CRITICAL'));
});

test('banner triggers from an active limit at or above 80%', () => {
  const state = baseState({
    session: { label: '5H', utilization: 85, timeToReset: 0, estimatedTimeToLimit: null, confidence: 'none', isActive: true },
  });
  const out = render(state);
  assert.ok(out.includes('WARNING'));
});

test('extra-usage footer prefers spend when enabled', () => {
  const state = baseState(
    { session: { label: '5H', utilization: 1, timeToReset: 0, estimatedTimeToLimit: null, confidence: 'none', isActive: true } },
    {
      spend: { enabled: true, used: { amount_minor: 1234, currency: 'USD', exponent: 2 }, cap: null, balance: null },
      extra_usage: { is_enabled: false, monthly_limit: null },
    }
  );
  const out = render(state);
  assert.ok(out.includes('extra usage: on'));
  assert.ok(out.includes('$12.34'));
});

test('extra-usage footer falls back to legacy extra_usage when spend is disabled', () => {
  const state = baseState(
    { session: { label: '5H', utilization: 1, timeToReset: 0, estimatedTimeToLimit: null, confidence: 'none', isActive: true } },
    {
      spend: { enabled: false },
      extra_usage: { is_enabled: true, monthly_limit: 500 },
    }
  );
  const out = render(state);
  assert.ok(out.includes('extra usage: on ($5.00/mo)'));
});
