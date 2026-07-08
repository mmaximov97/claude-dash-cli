# Usage Limits API Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt `claude-dash-cli` to Anthropic's updated `/api/oauth/usage` response shape — parse the new `limits[]` array (which now carries per-model weekly caps like the new Fable limit, previously in dead flat keys) and surface the new `spend` (usage-credits) field in the extra-usage footer.

**Architecture:** `src/usage.js`'s `_enrich()` switches from a hardcoded `LIMIT_KEYS` list to iterating `raw.limits[]`, deriving a stable key and display label per entry (`kind` + optional `scope.model.display_name`). `src/render.js` reads the precomputed `label`/`isActive` fields instead of a static `LABELS` map, dims inactive rows, excludes inactive limits from the banner-trigger comparison, and prefers `spend` over the legacy `extra_usage` for the footer.

**Tech Stack:** Plain Node.js ≥18, zero dependencies, `node:test` + `node:assert/strict` for tests (matches existing `tests/*.test.js`).

## Global Constraints

- Zero runtime dependencies (project pitch: "zero dependencies") — do not add any npm package.
- Node.js ≥ 18 (per `package.json` `engines`).
- Tests run via `node --test` (the `npm test` script) — new test files must be plain CommonJS using `node:test` / `node:assert/strict`, matching `tests/reflect.test.js` and `tests/watch.poller.test.js` style.
- No Co-Authored-By lines in commits (global git preference).

---

### Task 1: Dynamic `limits[]` parsing in `src/usage.js`

**Files:**
- Modify: `src/usage.js:13` (remove `LIMIT_KEYS`), `src/usage.js:136-156` (`_enrich`), `src/usage.js:275` (exports)
- Test: `tests/usage.enrich.test.js` (new)

**Interfaces:**
- Consumes: raw API response shape confirmed live — `raw.limits` is an array of `{kind, group, percent, severity, resets_at, scope: {model: {display_name}} | null, is_active}` entries (any entry may itself be `null`); `raw.spend` and `raw.extra_usage` are opaque objects passed through untouched.
- Produces: `UsageTracker._enrich(raw)` returns `{ timestamp, limits: { [key]: LimitEntry }, spend, extra_usage }` where `LimitEntry = { label, utilization, resets_at, timeToReset, estimatedTimeToLimit, consumptionRate, confidence, isActive, severity }`. `key` is `` `${kind}:${modelDisplayName}` `` when scoped to a model, else just `kind`. This `LimitEntry` shape (specifically `.label` and `.isActive`) is consumed by Task 2's `renderRow`/`render`.
- `module.exports` changes from `{ UsageTracker, LIMIT_KEYS }` to `{ UsageTracker }` — `LIMIT_KEYS` is not imported anywhere else in the repo (verified via grep).

- [ ] **Step 1: Write the failing test**

Create `tests/usage.enrich.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/usage.enrich.test.js`
Expected: FAIL — `Object.keys(result.limits)` will be `[]` (or throw), since `_enrich` still reads the old flat `LIMIT_KEYS` (all `null`/absent in the fixture) instead of `raw.limits`.

- [ ] **Step 3: Replace `LIMIT_KEYS` + `_enrich` with dynamic parsing**

In `src/usage.js`, delete line 13 (`const LIMIT_KEYS = [...]`).

Replace the `_enrich` method (current lines 136-156) with:

```js
  _enrich(raw) {
    const now = Date.now();
    const result = { timestamp: now, limits: {}, spend: raw.spend, extra_usage: raw.extra_usage };

    for (const entry of raw.limits || []) {
      if (!entry) continue;
      const key = this._limitKey(entry);
      const resetsAt = new Date(entry.resets_at).getTime();
      const timeToReset = Math.max(0, resetsAt - now);
      const prediction = this._predict(key, entry.percent);
      result.limits[key] = {
        label: this._limitLabel(entry),
        utilization: entry.percent,
        resets_at: entry.resets_at,
        timeToReset,
        estimatedTimeToLimit: prediction.eta,
        consumptionRate: prediction.rate,
        confidence: prediction.confidence,
        isActive: entry.is_active,
        severity: entry.severity,
      };
    }
    return result;
  }

  // Stable per-limit key: kind alone, or kind+model when scoped (e.g. 'weekly_scoped:Fable').
  // Any future per-model weekly limit gets its own key automatically — no hardcoded list.
  _limitKey(entry) {
    const model = entry.scope && entry.scope.model && entry.scope.model.display_name;
    return model ? `${entry.kind}:${model}` : entry.kind;
  }

  _limitLabel(entry) {
    if (entry.kind === 'session') return '5H';
    if (entry.kind === 'weekly_all') return '7D';
    const model = entry.scope && entry.scope.model && entry.scope.model.display_name;
    return model ? `${model} 7D` : entry.kind;
  }
```

Change the final export line (line 275) from:

```js
module.exports = { UsageTracker, LIMIT_KEYS };
```

to:

```js
module.exports = { UsageTracker };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/usage.enrich.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS — no other file imports `LIMIT_KEYS` (grep confirms only `src/usage.js` referenced it before this change).

- [ ] **Step 6: Commit**

```bash
git add src/usage.js tests/usage.enrich.test.js
git commit -m "feat(usage): parse limits[] dynamically for per-model weekly caps (Fable)"
```

---

### Task 2: Render inactive dimming, active-only banner, and spend-first extra-usage footer in `src/render.js`

**Files:**
- Modify: `src/render.js:27-33` (delete `LABELS`), `src/render.js:78-85` (`renderRow`), `src/render.js:214-232` (`render` — limit loop / `highest`), `src/render.js:250-258` (extra-usage footer)
- Test: `tests/render.test.js` (new)

**Interfaces:**
- Consumes: `LimitEntry` shape from Task 1 (`{ label, utilization, isActive, severity, timeToReset, estimatedTimeToLimit, confidence }`), plus `state.latest.spend` / `state.latest.extra_usage` passed through unchanged by `_enrich`.
- Produces: `renderRow(key, limit, width)` (unchanged signature, now reads `limit.label`/`limit.isActive`), `fmtMoneyMinor(m)` and `extraUsageLine(state)` (new, module-private, used only inside `render()`). `render(state)` return type unchanged (a single ANSI string).

- [ ] **Step 1: Write the failing tests**

Create `tests/render.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/render.test.js`
Expected: FAIL — `renderRow` still reads the static `LABELS` map (so `'5H'` label lookup by key `'session'` misses), doesn't dim inactive rows, the banner loop doesn't exclude inactive entries, and the footer only reads `extra_usage` (never `spend`).

- [ ] **Step 3: Remove the static `LABELS` map and stale TODO comment above `renderRow`**

In `src/render.js`, delete lines 27-33 (the `LABELS` object) — it's superseded by the `label` field `_enrich` now computes per entry.

Also delete the large `// ── TODO (you): render one limit row ──...` comment block (current lines 54-77) — the function below it is a real implementation now, not a scaffold placeholder, so the TODO text is stale.

- [ ] **Step 4: Rewrite `renderRow` to use `limit.label` and dim inactive rows**

Replace the current `renderRow` function (was lines 78-85) with:

```js
function renderRow(key, limit, width) {
  const label = limit.label || key;
  const pct = limit.utilization;
  const barW = Math.max(10, width - 55);
  const active = limit.isActive !== false;
  const color = active ? colorForPct(pct) : DIM;
  const tag = active ? '' : ' (inactive)';
  return `${BOLD}${label.padEnd(10)}${RESET} ${color}${bar(pct, barW)}${RESET} ${color}${pct.toFixed(1).padStart(5)}%${RESET} ${DIM}reset ${fmtDuration(limit.timeToReset)}  eta ${fmtDuration(limit.estimatedTimeToLimit)} ${confidenceGlyph(limit.confidence)}${tag}${RESET}`;
}
```

- [ ] **Step 5: Exclude inactive limits from the banner-trigger comparison**

In the `render(state)` function, find the limit loop (current lines 219-232):

```js
  for (const key of Object.keys(limits)) {
    const raw = limits[key];
    const live = {
      ...raw,
      timeToReset: Math.max(0, raw.timeToReset - elapsed),
      estimatedTimeToLimit: raw.estimatedTimeToLimit != null
        ? Math.max(0, raw.estimatedTimeToLimit - elapsed)
        : null,
    };
    lines.push(renderRow(key, live, width));
    if (!highest || live.utilization > highest.limit.utilization) {
      highest = { key, limit: live };
    }
  }
```

Replace the `highest` update with an active-only check:

```js
  for (const key of Object.keys(limits)) {
    const raw = limits[key];
    const live = {
      ...raw,
      timeToReset: Math.max(0, raw.timeToReset - elapsed),
      estimatedTimeToLimit: raw.estimatedTimeToLimit != null
        ? Math.max(0, raw.estimatedTimeToLimit - elapsed)
        : null,
    };
    lines.push(renderRow(key, live, width));
    const isActive = live.isActive !== false;
    if (isActive && (!highest || live.utilization > highest.limit.utilization)) {
      highest = { key, limit: live };
    }
  }
```

- [ ] **Step 6: Add `fmtMoneyMinor`/`extraUsageLine` helpers and switch the footer to prefer `spend`**

Add these two functions right before the `// ── Frame assembly ──` comment (i.e. just above current line 191, the `function render(state) {` block):

```js
// Formats a {amount_minor, currency, exponent} money object (e.g. spend.used/cap/balance).
// Returns null if `m` doesn't match that shape (unpopulated / unknown future shape) —
// callers omit the field rather than guessing at a format.
function fmtMoneyMinor(m) {
  if (!m || typeof m.amount_minor !== 'number') return null;
  const exp = typeof m.exponent === 'number' ? m.exponent : 2;
  const value = m.amount_minor / 10 ** exp;
  const symbol = m.currency === 'USD' ? '$' : (m.currency ? m.currency + ' ' : '');
  return `${symbol}${value.toFixed(exp)}`;
}

// Prefers the new `spend` (usage-credits) field when enabled; otherwise falls back
// to the legacy `extra_usage` on/off + monthly cap display.
function extraUsageLine(state) {
  const spend = state.latest.spend;
  if (spend && spend.enabled) {
    const used = fmtMoneyMinor(spend.used);
    const cap = fmtMoneyMinor(spend.cap);
    const balance = fmtMoneyMinor(spend.balance);
    const parts = ['extra usage: on'];
    const usedCap = [used && `used ${used}`, cap && `cap ${cap}`].filter(Boolean).join(' / ');
    if (usedCap) parts.push(`(${usedCap})`);
    if (balance) parts.push(`balance ${balance}`);
    return parts.join(' ');
  }
  const eu = state.latest.extra_usage;
  if (!eu) return null;
  return eu.is_enabled
    ? (eu.monthly_limit ? `extra usage: on ($${(eu.monthly_limit / 100).toFixed(2)}/mo)` : 'extra usage: on')
    : 'extra usage: off';
}
```

Then replace the extra-usage footer block (current lines 250-258):

```js
  // Extra-usage footer (monthly $ cap, if plan has it)
  if (state.latest.extra_usage) {
    const eu = state.latest.extra_usage;
    const txt = eu.is_enabled
      ? (eu.monthly_limit ? `extra usage: on ($${(eu.monthly_limit / 100).toFixed(2)}/mo)` : 'extra usage: on')
      : 'extra usage: off';
    lines.push('');
    lines.push(`${DIM}${txt}${RESET}`);
  }
```

with:

```js
  // Extra-usage footer — prefers spend (usage credits) when enabled, else legacy extra_usage.
  const euText = extraUsageLine(state);
  if (euText) {
    lines.push('');
    lines.push(`${DIM}${euText}${RESET}`);
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test tests/render.test.js`
Expected: PASS (6 tests)

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing suites (`reflect`, `harness.*`, `watch.poller`, `model.tree`, plus the two new files) green.

- [ ] **Step 9: Manual smoke test against the live account**

Run: `node src/index.js` for a few seconds, then Ctrl-C.
Expected: dashboard renders `5H`, `7D`, and `Fable 7D` rows without crashing; `Fable 7D` (and `7D`, both currently `is_active: false` on this account) render dimmed with `(inactive)`; footer shows `extra usage: off` (this account's `spend`/`extra_usage` are both currently disabled).

- [ ] **Step 10: Commit**

```bash
git add src/render.js tests/render.test.js
git commit -m "feat(render): dim inactive limits, exclude them from banner, prefer spend for extra-usage footer"
```
