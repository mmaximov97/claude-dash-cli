const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageTracker } = require('../src/usage');

// Real response shape captured live from api.anthropic.com/api/oauth/usage on 2026-07-08.
function rawFixture() {
  return {
    five_hour: { utilization: 23.0, resets_at: '2026-07-08T13:19:59.373624+00:00' },
    seven_day: { utilization: 3.0, resets_at: '2026-07-15T12:00:00.373652+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    limits: [
      { kind: 'session', group: 'session', percent: 23, severity: 'normal',
        resets_at: '2026-07-08T13:19:59.373624+00:00', scope: null, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 3, severity: 'normal',
        resets_at: '2026-07-15T12:00:00.373652+00:00', scope: null, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 1, severity: 'normal',
        resets_at: '2026-07-15T12:00:00.374073+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      null,
    ],
    extra_usage: { is_enabled: false, monthly_limit: null },
    spend: { enabled: false, used: { amount_minor: 0, currency: 'USD', exponent: 2 }, cap: null, balance: null },
  };
}

test('_enrich derives session/weekly_all/weekly_scoped keys and labels', () => {
  const tracker = new UsageTracker({});
  const result = tracker._enrich(rawFixture());

  assert.deepEqual(Object.keys(result.limits).sort(), ['session', 'weekly_all', 'weekly_scoped:Fable']);
  assert.equal(result.limits.session.label, '5H');
  assert.equal(result.limits.weekly_all.label, '7D');
  assert.equal(result.limits['weekly_scoped:Fable'].label, 'Fable 7D');
});

test('_enrich carries utilization, isActive and severity through', () => {
  const tracker = new UsageTracker({});
  const result = tracker._enrich(rawFixture());

  assert.equal(result.limits.session.utilization, 23);
  assert.equal(result.limits.session.isActive, true);
  assert.equal(result.limits['weekly_scoped:Fable'].utilization, 1);
  assert.equal(result.limits['weekly_scoped:Fable'].isActive, false);
  assert.equal(result.limits['weekly_scoped:Fable'].severity, 'normal');
});

test('_enrich skips null entries in raw.limits without throwing', () => {
  const tracker = new UsageTracker({});
  assert.doesNotThrow(() => tracker._enrich(rawFixture()));
});

test('_enrich passes spend and extra_usage through untouched', () => {
  const tracker = new UsageTracker({});
  const raw = rawFixture();
  const result = tracker._enrich(raw);

  assert.equal(result.spend, raw.spend);
  assert.equal(result.extra_usage, raw.extra_usage);
});

test('_enrich handles a missing limits array (produces zero rows, no throw)', () => {
  const tracker = new UsageTracker({});
  const raw = rawFixture();
  delete raw.limits;
  const result = tracker._enrich(raw);
  assert.deepEqual(result.limits, {});
});
